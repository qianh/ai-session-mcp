import { hostname } from "node:os";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import { google } from "googleapis";

import { discoverSessions } from "../adapters/index.js";
import { GoogleOAuth } from "../auth/google-oauth.js";
import { PlatformSecretStore } from "../auth/platform-secrets.js";
import type { BrainHubConfig, PlatformPaths } from "../domain/config.js";
import { BrainHubError } from "../domain/errors.js";
import type { SessionSource } from "../domain/session.js";
import type { DrivePort } from "../drive/drive-port.js";
import { GoogleDrive } from "../drive/google-drive.js";
import { MemoryDrive } from "../drive/memory-drive.js";
import { PortraitService } from "../portrait/portrait-service.js";
import { SchedulerManager } from "../scheduler/manager.js";
import { E5Embedder } from "../search/e5-embedder.js";
import { SearchService } from "../search/search-service.js";
import { SqliteStateStore } from "../state/sqlite-store.js";
import type { DeviceState, SessionState, StateStore } from "../state/store.js";
import { StatusService } from "../status/status-service.js";
import { UploadLock } from "../upload/lock.js";
import { UploadService, type UploadOutput } from "../upload/upload-service.js";

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

const adapterStatusKey: Record<SessionSource, "claude" | "codex" | "grok"> = {
  "claude-code": "claude",
  codex: "codex",
  "grok-build": "grok",
};

export class BrainHubRuntime {
  readonly config: BrainHubConfig;
  readonly paths: PlatformPaths;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly executable: string;
  readonly executableArgs: string[];
  #stateStore: SqliteStateStore | null = null;
  #drivePort: DrivePort | null = null;

  constructor(options: {
    config: BrainHubConfig;
    paths: PlatformPaths;
    homeDir: string;
    platform: NodeJS.Platform;
    executable: string;
    executableArgs?: string[];
  }) {
    this.config = options.config;
    this.paths = options.paths;
    this.homeDir = options.homeDir;
    this.platform = options.platform;
    this.executable = options.executable;
    this.executableArgs = options.executableArgs ?? [];
  }

  #state(): SqliteStateStore {
    this.#stateStore ??= new SqliteStateStore(this.paths.stateFile);
    return this.#stateStore;
  }

  async drive(interactive = false): Promise<DrivePort> {
    if (this.#drivePort) return this.#drivePort;
    if (!this.config.drive.rootFolderId) {
      throw new BrainHubError(
        "DRIVE_ROOT_REQUIRED",
        "Run `brain-mcp drive init` first",
      );
    }
    const secrets = new PlatformSecretStore({
      platform: this.platform,
      account: this.config.device.name,
    });
    const auth = await new GoogleOAuth(
      this.config.drive.oauthClientFile,
      secrets,
    ).getClient({ interactive });
    const client = google.drive({ version: "v3", auth });
    this.#drivePort = new GoogleDrive({
      client,
      rootFolderId: this.config.drive.rootFolderId,
    });
    return this.#drivePort;
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
      sources: input.sources ?? ["claude-code", "codex", "grok-build"],
      paths: {
        claude: this.config.capture.claudePaths,
        codex: this.config.capture.codexPaths,
        grok: this.config.capture.grokPaths,
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
  }): Promise<UploadOutput & { adapters: object }> {
    const dryRun = input.dryRun ?? false;
    const state: StateStore = dryRun ? new VolatileStateStore() : this.#state();
    const sources = input.sources ?? ["claude-code", "codex", "grok-build"];
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
        if (output.uploaded > 0) {
          try {
            await this.searchService(drive).sync();
          } catch {
            output.warnings.push({
              code: "INDEX_STALE",
              message: "Upload succeeded but search index refresh failed",
            });
          }
        }
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
    return { ...output, adapters: discovery.status };
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

  async portraitService(): Promise<PortraitService> {
    return new PortraitService({
      drive: await this.drive(false),
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
  async pullPortrait() {
    return (await this.portraitService()).pullPortrait();
  }

  async hubStatus() {
    const scheduler = new SchedulerManager({
      platform: this.platform,
      homeDir: this.homeDir,
      command: this.executable,
      args: this.executableArgs,
    });
    return new StatusService({
      drive: () => this.drive(false),
      adapters: async () => (await this.discover({})).status,
      scheduler: () => scheduler.status(),
    }).getStatus();
  }

  close(): void {
    this.#stateStore?.close();
    this.#stateStore = null;
  }
}
