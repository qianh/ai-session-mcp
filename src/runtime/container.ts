import { createRequire } from "node:module";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";

import { google, type drive_v3 } from "googleapis";

import { discoverSessions } from "../adapters/index.js";
import { GoogleOAuth, type GoogleOAuthClient } from "../auth/google-oauth.js";
import {
  createConfigSecretStore,
  type ConfigSecretStoreFactory,
} from "../auth/secret-store-factory.js";
import type { BrainHubConfig, PlatformPaths } from "../domain/config.js";
import { BrainHubError } from "../domain/errors.js";
import {
  conversationKey,
  SESSION_SOURCES,
  type SessionSource,
} from "../domain/session.js";
import type { DrivePort } from "../drive/drive-port.js";
import { GoogleDrive } from "../drive/google-drive.js";
import { MemoryDrive } from "../drive/memory-drive.js";
import { PortraitService } from "../portrait/portrait-service.js";
import { PortraitSyncService } from "../portrait/portrait-sync-service.js";
import { SchedulerManager } from "../scheduler/manager.js";
import { E5Embedder } from "../search/e5-embedder.js";
import { isModelReady } from "../search/model-cache.js";
import { SearchService } from "../search/search-service.js";
import { SqliteStateStore } from "../state/sqlite-store.js";
import type { DeviceState, SessionState, StateStore } from "../state/store.js";
import { StatusService } from "../status/status-service.js";
import { discoverPublishDirectory } from "../portrait/obsidian.js";
import { UploadLock } from "../upload/lock.js";
import { UploadService, type UploadOutput } from "../upload/upload-service.js";
import {
  FileUpdateCache,
  UpdateCheckService,
  fetchNpmLatestVersion,
} from "../update/update-check-service.js";

const packageMetadata = createRequire(import.meta.url)(
  "../../package.json",
) as {
  version: string;
};

class VolatileStateStore implements StateStore {
  getOrCreateDevice(name: string): DeviceState {
    return { id: "dry-run", name, createdAt: new Date(0).toISOString() };
  }
  markPending(): boolean {
    return true;
  }
  markFailed(): void {}
  markUploaded(): void {}
  getSession(): SessionState | null {
    return null;
  }
  listPending(): SessionState[] {
    return [];
  }
  getDiscoveryWatermark(): string | null {
    return null;
  }
  setDiscoveryWatermark(): void {}
}

const adapterStatusKey: Record<
  SessionSource,
  "claude" | "codex" | "grok" | "cursor"
> = {
  "claude-code": "claude",
  codex: "codex",
  "grok-build": "grok",
  cursor: "cursor",
};

async function directorySize(path: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      total += entry.isDirectory()
        ? await directorySize(child)
        : (await stat(child)).size;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return total;
}

export class BrainHubRuntime {
  readonly config: BrainHubConfig;
  readonly paths: PlatformPaths;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly configFile: string;
  readonly executable: string;
  readonly executableArgs: string[];
  #stateStore: SqliteStateStore | null = null;
  #drivePort: DrivePort | null = null;
  #myDrivePort: DrivePort | null = null;
  #googleDriveClient: drive_v3.Drive | null = null;
  readonly #secretStoreFactory: ConfigSecretStoreFactory;
  readonly #driveFactory: (auth: GoogleOAuthClient) => drive_v3.Drive;

  constructor(options: {
    config: BrainHubConfig;
    paths: PlatformPaths;
    configFile: string;
    homeDir: string;
    platform: NodeJS.Platform;
    executable: string;
    executableArgs?: string[];
    secretStoreFactory?: ConfigSecretStoreFactory;
    driveFactory?: (auth: GoogleOAuthClient) => drive_v3.Drive;
  }) {
    this.config = options.config;
    this.paths = options.paths;
    this.homeDir = options.homeDir;
    this.platform = options.platform;
    this.configFile = options.configFile;
    this.executable = options.executable;
    this.executableArgs = options.executableArgs ?? [];
    this.#secretStoreFactory =
      options.secretStoreFactory ?? createConfigSecretStore;
    this.#driveFactory =
      options.driveFactory ?? ((auth) => google.drive({ version: "v3", auth }));
  }

  #state(): SqliteStateStore {
    this.#stateStore ??= new SqliteStateStore(this.paths.stateFile, {
      ...(this.paths.legacyStateFile
        ? { legacyPath: this.paths.legacyStateFile }
        : {}),
    });
    return this.#stateStore;
  }

  async drive(interactive = false): Promise<DrivePort> {
    if (this.#drivePort) return this.#drivePort;
    if (!this.config.drive.rootFolderId) {
      throw new BrainHubError(
        "DRIVE_ROOT_REQUIRED",
        "Run `brainhub-mcp setup` first",
      );
    }
    const secrets = this.#secretStoreFactory({
      platform: this.platform,
      configFile: this.configFile,
      legacyAccount: this.config.device.name,
    });
    const auth = await new GoogleOAuth(
      this.config.drive.oauthClientFile,
      secrets,
    ).getClient({ interactive });
    const client = this.#driveFactory(auth);
    this.#googleDriveClient = client;
    this.#drivePort = new GoogleDrive({
      client,
      rootFolderId: this.config.drive.rootFolderId,
    });
    return this.#drivePort;
  }

  async #myDrive(): Promise<DrivePort> {
    if (this.#myDrivePort) return this.#myDrivePort;
    await this.drive(false);
    if (!this.#googleDriveClient) {
      throw new BrainHubError(
        "DRIVE_ROOT_REQUIRED",
        "Google Drive client is not initialized",
      );
    }
    this.#myDrivePort = await GoogleDrive.openMyDrive(this.#googleDriveClient);
    return this.#myDrivePort;
  }

  async discover(input: {
    sources?: SessionSource[];
    includeSubagents?: boolean;
    modifiedAfter?: Partial<Record<SessionSource, string>>;
    includePaths?: string[];
  }) {
    return discoverSessions({
      device: this.config.device.name || hostname(),
      includeSubagents:
        input.includeSubagents ?? this.config.capture.includeSubagents,
      sources: input.sources ?? [...SESSION_SOURCES],
      paths: {
        claude: this.config.capture.claudePaths,
        codex: this.config.capture.codexPaths,
        grok: this.config.capture.grokPaths,
        cursor: this.config.capture.cursorPaths,
      },
      ...(input.modifiedAfter ? { modifiedAfter: input.modifiedAfter } : {}),
      ...(input.includePaths ? { includePaths: input.includePaths } : {}),
    });
  }

  async uploadSessions(input: {
    sources?: SessionSource[];
    includeSubagents?: boolean;
    dryRun?: boolean;
    backfill?: boolean;
  }): Promise<UploadOutput & { adapters: object; pending: number }> {
    const dryRun = input.dryRun ?? false;
    const state: StateStore = dryRun ? new VolatileStateStore() : this.#state();
    const sources = input.sources ?? [...SESSION_SOURCES];
    const scanStartedAt = new Date().toISOString();
    const backfill = input.backfill ?? false;
    const discovery = await this.discover({
      ...input,
      sources,
      ...(!backfill
        ? {
            modifiedAfter: Object.fromEntries(
              sources.map((source) => [
                source,
                state.getDiscoveryWatermark(source) ?? scanStartedAt,
              ]),
            ) as Partial<Record<SessionSource, string>>,
            includePaths: state
              .listPending(10_000)
              .filter((session) => sources.includes(session.source))
              .map((session) => session.sourcePath),
          }
        : {}),
    });
    const device = dryRun
      ? state.getOrCreateDevice(this.config.device.name)
      : state.getOrCreateDevice(this.config.device.name);
    const drive = dryRun ? new MemoryDrive() : await this.drive(false);
    const service = new UploadService({
      drive,
      state,
      deviceId: device.id,
      concurrency: this.config.upload.concurrency,
      redaction: {
        internalDomains: this.config.capture.internalDomains,
        internalCidrs: this.config.capture.internalCidrs,
      },
    });
    let output: UploadOutput;
    if (dryRun) {
      output = await service.uploadSessions(discovery.sessions, {
        dryRun: true,
      });
    } else {
      await mkdir(dirname(this.paths.stateFile), { recursive: true });
      const lock = new UploadLock(`${this.paths.stateFile}.upload.lock`);
      await lock.acquire();
      try {
        output = await service.uploadSessions(discovery.sessions, {
          dryRun: false,
        });
      } finally {
        await lock.release();
      }
    }
    if (!dryRun) {
      for (const source of sources) {
        if (discovery.status[adapterStatusKey[source]].errors === 0) {
          state.setDiscoveryWatermark(source, scanStartedAt);
        }
      }
    }
    output.skippedSubagents = discovery.skippedSubagents;
    output.malformed = discovery.malformed;
    output.warnings.push(...discovery.warnings);
    return {
      ...output,
      adapters: discovery.status,
      pending: dryRun ? 0 : state.listPending(10_000).length,
    };
  }

  searchService(drive: DrivePort): SearchService {
    return new SearchService({
      drive,
      embedder: new E5Embedder({
        model: this.config.search.model,
        revision: this.config.search.modelRevision,
        dimensions: this.config.search.dimensions,
        cacheDir: this.paths.modelCache,
      }),
      indexPath: this.paths.searchIndexFile,
      chunkTokens: this.config.search.chunkTokens,
      chunkOverlap: this.config.search.chunkOverlap,
    });
  }

  async searchSessions(input: {
    query: string;
    from?: string;
    to?: string;
    sources?: string[];
    limit?: number;
  }) {
    const drive = await this.drive(false);
    return this.searchService(drive).search({
      query: input.query,
      limit: Math.min(
        input.limit ?? this.config.search.defaultLimit,
        this.config.search.maxLimit,
      ),
      ...(input.sources ? { sources: input.sources } : {}),
      ...(input.from ? { since: input.from } : {}),
      ...(input.to ? { until: input.to } : {}),
    });
  }

  async getSession(input: {
    source: SessionSource;
    conversationId: string;
  }): Promise<{
    source: SessionSource;
    conversationId: string;
    content: string;
    updatedAt: string;
  }> {
    const drive = await this.drive(false);
    const entries = await drive.list({
      prefix: "inbox/",
      appProperty: {
        key: "brainhubKey",
        value: conversationKey(input.source, input.conversationId),
      },
    });
    const entry = entries
      .filter(
        (candidate) =>
          candidate.path.startsWith("inbox/") &&
          candidate.mimeType === "text/markdown" &&
          candidate.appProperties.source === input.source &&
          candidate.appProperties.conversationId === input.conversationId,
      )
      .sort(
        (left, right) =>
          (right.appProperties.updatedAt ?? right.modifiedTime).localeCompare(
            left.appProperties.updatedAt ?? left.modifiedTime,
          ) || right.id.localeCompare(left.id),
      )[0];
    if (!entry) {
      throw new BrainHubError(
        "SESSION_NOT_FOUND",
        `Inbox session ${input.source}/${input.conversationId} is not available`,
      );
    }
    const object = await drive.read(entry.id);
    return {
      source: input.source,
      conversationId: input.conversationId,
      content: object.bytes.toString("utf8"),
      updatedAt: entry.appProperties.updatedAt ?? entry.modifiedTime,
    };
  }

  #portraitPath(): string {
    const { directory, fileName } = this.config.portrait;
    return directory
      ? `${directory.replace(/\/+$/, "")}/${fileName}`
      : fileName;
  }

  async portraitService(): Promise<PortraitService> {
    return new PortraitService({
      drive: await this.#myDrive(),
      path: this.#portraitPath(),
      outputPath: join(
        dirname(this.configFile),
        "portrait",
        this.config.portrait.fileName,
      ),
    });
  }

  async portraitSyncService(): Promise<PortraitSyncService> {
    return new PortraitSyncService({
      portraitSource: {
        drive: await this.#myDrive(),
        path: this.#portraitPath(),
      },
      publish: {
        platform: this.platform,
        homeDir: this.homeDir,
        fallbackPath: this.config.publish.fallbackPath,
        ...(process.env.XDG_CONFIG_HOME
          ? { xdgConfigHome: process.env.XDG_CONFIG_HOME }
          : {}),
      },
    });
  }

  async getPortrait() {
    return (await this.portraitService()).getPortrait();
  }
  async syncPortrait() {
    return (await this.portraitSyncService()).sync();
  }

  async hubStatus() {
    const scheduler = new SchedulerManager({
      platform: this.platform,
      homeDir: this.homeDir,
      command: this.executable,
      args: this.executableArgs,
    });
    return new StatusService({
      account: {
        connected: Boolean(this.config.drive.accountPermissionId),
        ...(this.config.drive.accountEmail
          ? { email: this.config.drive.accountEmail }
          : {}),
        ...(this.config.drive.accountDisplayName
          ? { displayName: this.config.drive.accountDisplayName }
          : {}),
      },
      root: {
        configured: Boolean(this.config.drive.rootFolderId),
        name: this.config.drive.rootFolderName,
        ...(this.config.drive.rootFolderId
          ? { id: this.config.drive.rootFolderId }
          : {}),
      },
      drive: () => this.drive(false),
      upload: async () => (await this.discover({})).status,
      model: async () => {
        const bytes = await directorySize(this.paths.modelCache);
        const ready = await isModelReady(this.paths.modelCache, {
          model: this.config.search.model,
          revision: this.config.search.modelRevision,
          dimensions: this.config.search.dimensions,
        });
        return { ready, bytes, cachePath: this.paths.modelCache };
      },
      index: async () => this.searchService(await this.drive(false)).status(),
      launchd: () => scheduler.status(),
      portrait: async () => {
        const portrait = await (
          await this.#myDrive()
        ).readPath(this.#portraitPath());
        return portrait
          ? { available: true, modifiedAt: portrait.modifiedTime }
          : { available: false };
      },
      obsidian: async () => {
        const path = await discoverPublishDirectory({
          platform: this.platform,
          homeDir: this.homeDir,
          fallbackPath: this.config.publish.fallbackPath,
          ...(process.env.XDG_CONFIG_HOME
            ? { xdgConfigHome: process.env.XDG_CONFIG_HOME }
            : {}),
        });
        return path ? { configured: true, path } : { configured: false };
      },
      update: () =>
        new UpdateCheckService({
          currentVersion: packageMetadata.version,
          cache: new FileUpdateCache(
            join(
              dirname(dirname(dirname(this.paths.stateFile))),
              "update-check.json",
            ),
          ),
          fetchLatest: fetchNpmLatestVersion,
        }).check(),
    }).getStatus();
  }

  close(): void {
    this.#stateStore?.close();
    this.#stateStore = null;
  }
}
