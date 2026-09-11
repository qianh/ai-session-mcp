import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import type { SecretStore } from "../../src/auth/secret-store.js";
import type { ConfigSecretStoreOptions } from "../../src/auth/secret-store-factory.js";
import { createDefaultConfig, platformPaths } from "../../src/domain/config.js";
import { conversationKey } from "../../src/domain/session.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { BrainHubRuntime } from "../../src/runtime/container.js";
import type { Embedder } from "../../src/search/embedder.js";
import { SearchService } from "../../src/search/search-service.js";
import { SqliteStateStore } from "../../src/state/sqlite-store.js";

const fixtures = resolve(import.meta.dirname, "..", "fixtures");

class UnavailableEmbedder implements Embedder {
  readonly model = "cursor-runtime-test";
  readonly revision = "v1";
  readonly dimensions = 3;

  async embedQuery(): Promise<number[]> {
    throw new Error("model unavailable");
  }

  async embedPassages(): Promise<number[][]> {
    throw new Error("model unavailable");
  }
}

async function runtimeFixture(
  options: {
    configFile?: string;
    secretStoreFactory?: (options: ConfigSecretStoreOptions) => SecretStore;
    driveFactory?: () => object;
  } = {},
) {
  const homeDir = await mkdtemp(join(tmpdir(), "brainhub-runtime-"));
  const config = createDefaultConfig({
    hostname: "test-device",
    homeDir,
    platform: "linux",
  });
  const paths = platformPaths({ platform: "linux", homeDir });
  return {
    homeDir,
    config,
    paths,
    runtime: new BrainHubRuntime({
      config,
      paths,
      configFile: options.configFile ?? join(homeDir, "config.toml"),
      homeDir,
      platform: "linux",
      executable: process.execPath,
      executableArgs: [resolve("dist/cli/index.js")],
      ...(options.secretStoreFactory
        ? { secretStoreFactory: options.secretStoreFactory }
        : {}),
      ...(options.driveFactory
        ? { driveFactory: options.driveFactory as never }
        : {}),
    }),
  };
}

function configureSourceRoots(
  homeDir: string,
  config: ReturnType<typeof createDefaultConfig>,
) {
  const histories = join(homeDir, "histories");
  const roots = {
    claude: join(histories, "claude"),
    codex: join(histories, "codex"),
    grok: join(histories, "grok"),
    cursor: join(histories, "cursor"),
  };
  config.capture.claudePaths = [roots.claude];
  config.capture.codexPaths = [roots.codex];
  config.capture.grokPaths = [roots.grok];
  config.capture.cursorPaths = [roots.cursor];
  return roots;
}

async function writeCursorFixture(root: string, id = "cursor-1") {
  const path = join(root, "workspace", "agent-transcripts", id, `${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await cp(join(fixtures, "cursor", "top-level.jsonl"), path);
  return path;
}

async function writeSourceFixtures(
  roots: ReturnType<typeof configureSourceRoots>,
  options: { invalidGrokSummary?: boolean } = {},
) {
  const claude = join(roots.claude, "project", "session.jsonl");
  const codex = join(roots.codex, "2026", "07", "18", "rollout-test.jsonl");
  const grok = join(roots.grok, "project", "session");
  const grokHistory = join(grok, "chat_history.jsonl");
  await Promise.all([
    mkdir(dirname(claude), { recursive: true }),
    mkdir(dirname(codex), { recursive: true }),
    mkdir(grok, { recursive: true }),
  ]);
  const cursor = await writeCursorFixture(roots.cursor);
  await Promise.all([
    cp(join(fixtures, "claude", "top-level.jsonl"), claude),
    cp(join(fixtures, "codex", "top-level.jsonl"), codex),
    cp(join(fixtures, "grok", "top-level", "chat_history.jsonl"), grokHistory),
    options.invalidGrokSummary
      ? writeFile(join(grok, "summary.json"), "{")
      : cp(
          join(fixtures, "grok", "top-level", "summary.json"),
          join(grok, "summary.json"),
        ),
  ]);
  return { claude, codex, grok, grokHistory, cursor };
}

describe("BrainHub runtime", () => {
  it("reads a complete session only from inbox by stable session reference", async () => {
    const { runtime } = await runtimeFixture();
    const drive = new MemoryDrive();
    const properties = {
      brainhubKey: conversationKey("codex", "session-1"),
      source: "codex",
      conversationId: "session-1",
      updatedAt: "2026-07-26T00:00:00.000Z",
    };
    await drive.put({
      path: "sessions/2026-07/session.md",
      bytes: Buffer.from("outside inbox"),
      mimeType: "text/markdown",
      appProperties: properties,
    });
    await drive.put({
      path: "inbox/macbook/codex-session.md",
      bytes: Buffer.from("# Complete session\n"),
      mimeType: "text/markdown",
      appProperties: properties,
    });
    vi.spyOn(runtime, "drive").mockResolvedValue(drive);

    const result = await runtime.getSession({
      source: "codex",
      conversationId: "session-1",
    });

    expect(result).toEqual({
      source: "codex",
      conversationId: "session-1",
      content: "# Complete session\n",
      updatedAt: "2026-07-26T00:00:00.000Z",
    });
    runtime.close();
  });

  it("returns a stable error when an inbox session does not exist", async () => {
    const { runtime } = await runtimeFixture();
    vi.spyOn(runtime, "drive").mockResolvedValue(new MemoryDrive());

    await expect(
      runtime.getSession({ source: "claude-code", conversationId: "missing" }),
    ).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
      retryable: false,
    });
    runtime.close();
  });

  it.each([
    { directory: "", fileName: "Digital_Twin_Profile.md", legacy: false },
    { directory: "", fileName: "Custom_Profile.md", legacy: false },
    { directory: "Profiles///", fileName: "Custom_Profile.md", legacy: false },
    { directory: "Profiles", fileName: "Custom_Profile.md", legacy: true },
  ])(
    "reads and reports the configured portrait: $directory/$fileName (legacy: $legacy)",
    async ({ directory, fileName, legacy }) => {
      const profile = {
        id: "profile-1",
        name: fileName,
        mimeType: "text/markdown",
        parents: [directory ? "profiles-folder" : "my-drive-root"],
        size: "15",
        modifiedTime: "2026-07-25T00:00:00.000Z",
        appProperties: {},
        version: "1",
        trashed: false,
      };
      const files = [
        profile,
        ...(directory
          ? [
              {
                ...profile,
                id: "profiles-folder",
                name: "Profiles",
                mimeType: "application/vnd.google-apps.folder",
                parents: ["my-drive-root"],
              },
            ]
          : []),
        ...(legacy
          ? [
              {
                ...profile,
                id: "legacy-profile",
                name: "Digital_Twin_Profile.md",
                parents: ["my-drive-root"],
                modifiedTime: "2025-01-01T00:00:00.000Z",
              },
            ]
          : []),
      ];
      const client = {
        files: {
          list: async (request: { q?: string }) => ({
            data: {
              files: files.filter(
                (file) =>
                  request.q?.includes(`'${file.parents[0]}' in parents`) &&
                  (!request.q.includes("name =") ||
                    request.q.includes(`name = '${file.name}'`)),
              ),
            },
          }),
          get: async (request: { fileId?: string; alt?: string }) => {
            if (request.fileId === "root") {
              return { data: { id: "my-drive-root" } };
            }
            if (request.alt === "media") {
              return { data: Buffer.from("# Runtime Digital Twin\n") };
            }
            return {
              data: files.find((file) => file.id === request.fileId),
              headers: { etag: "profile-etag" },
            };
          },
        },
      };
      const fixture = await runtimeFixture({
        secretStoreFactory: () => ({
          get: async () =>
            JSON.stringify({
              access_token: "access-token",
              refresh_token: "refresh-token",
              expiry_date: Date.now() + 60 * 60_000,
            }),
          set: async () => undefined,
          delete: async () => undefined,
        }),
        driveFactory: () => client,
      });
      const oauthClientFile = join(fixture.homeDir, "oauth.json");
      await writeFile(
        oauthClientFile,
        JSON.stringify({
          installed: {
            client_id: "client-id",
            client_secret: "client-secret",
            redirect_uris: ["http://127.0.0.1"],
          },
        }),
      );
      fixture.config.drive.rootFolderId = "brain-hub-root";
      fixture.config.drive.oauthClientFile = oauthClientFile;
      fixture.config.portrait = { directory, fileName };
      fixture.config.publish.fallbackPath = join(fixture.homeDir, "publish");

      const result = await fixture.runtime.getPortrait();

      expect(result.portrait).toBe("# Runtime Digital Twin\n");
      expect((await fixture.runtime.hubStatus()).portrait).toEqual({
        available: true,
        modifiedAt: profile.modifiedTime,
      });
      fixture.runtime.close();
    },
  );

  it("does not couple a successful upload to search indexing", async () => {
    const { runtime, config } = await runtimeFixture();
    const sourcePath = join(
      dirname(config.capture.codexPaths[0]!),
      "sessions",
      "2026",
      "07",
      "18",
      "rollout-test.jsonl",
    );
    config.capture.codexPaths = [
      dirname(dirname(dirname(dirname(sourcePath)))),
    ];
    await mkdir(dirname(sourcePath), { recursive: true });
    await cp(join(fixtures, "codex", "top-level.jsonl"), sourcePath);
    const drive = new MemoryDrive();
    vi.spyOn(runtime, "drive").mockResolvedValue(drive);
    const search = vi.spyOn(runtime, "searchService").mockImplementation(() => {
      throw new Error("search indexing must be explicit");
    });

    const result = await runtime.uploadSessions({
      sources: ["codex"],
      backfill: true,
    });

    expect(result.uploaded).toBe(1);
    expect(search).not.toHaveBeenCalled();
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: expect.stringMatching(/^INDEX_/) }),
    );
    expect(
      (await drive.list({ prefix: "" })).every((entry) =>
        entry.path.startsWith("inbox/"),
      ),
    ).toBe(true);
    runtime.close();
  });

  it("uploads, redacts, searches, and reads a Cursor session", async () => {
    const { runtime, config, paths, homeDir } = await runtimeFixture();
    const roots = configureSourceRoots(homeDir, config);
    await writeCursorFixture(roots.cursor, "cursor-session");
    const drive = new MemoryDrive();
    vi.spyOn(runtime, "drive").mockResolvedValue(drive);

    const upload = await runtime.uploadSessions({
      sources: ["cursor"],
      backfill: true,
    });

    expect(upload).toMatchObject({
      scanned: 1,
      uploaded: 1,
      redactions: 1,
      adapters: { cursor: { captured: 1, malformed: 1, errors: 0 } },
    });
    const entry = (await drive.list({ prefix: "inbox/" })).find(
      (candidate) => candidate.appProperties.source === "cursor",
    )!;
    const markdown = (await drive.read(entry.id)).bytes.toString("utf8");
    expect(markdown).toContain("Authorization: Bearer [REDACTED]");
    expect(markdown).not.toContain("cursor-secret-value");
    expect(markdown).not.toContain("private reasoning");
    expect(markdown).not.toContain("secret-tool-path");
    expect(markdown).not.toContain("private tool metadata");

    const search = await new SearchService({
      drive,
      embedder: new UnavailableEmbedder(),
      indexPath: paths.searchIndexFile,
    }).search({
      query: "indexed path",
      sources: ["cursor"],
      limit: 10,
    });
    expect(search.results).toMatchObject([
      { source: "cursor", conversationId: "cursor-session" },
    ]);

    const complete = await runtime.getSession({
      source: "cursor",
      conversationId: "cursor-session",
    });
    expect(complete.content).toBe(markdown);
    runtime.close();
  });

  it("returns local hub status when Drive is not configured", async () => {
    const { runtime } = await runtimeFixture();

    const result = await runtime.hubStatus();

    expect(result.account).toEqual({ connected: false });
    expect(result.root).toEqual({ configured: false, name: "brain-hub" });
    expect(result.upload).toMatchObject({
      driveReachable: false,
      inbox: {},
      adapters: {
        claude: { discovered: 0 },
        codex: { discovered: 0 },
        grok: { discovered: 0 },
        cursor: { discovered: 0 },
      },
    });
    expect(result.model).toMatchObject({ ready: false, bytes: 0 });
    expect(result.index).toEqual({});
    expect(result.launchd).toMatchObject({
      installed: false,
      platform: "linux",
    });
    expect(result.obsidian).toEqual({ configured: false });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "DRIVE_UNAVAILABLE" }),
    );
    runtime.close();
  });

  it("does not report a partial model cache as ready", async () => {
    const { runtime, paths } = await runtimeFixture();
    await mkdir(paths.modelCache, { recursive: true });
    await writeFile(join(paths.modelCache, "partial-download.bin"), "partial");

    const result = await runtime.hubStatus();

    expect(result.model).toMatchObject({ ready: false });
    expect((result.model as { bytes: number }).bytes).toBeGreaterThan(0);
    runtime.close();
  });

  it("isolates runtime credentials by resolved config file", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "brainhub-runtime-auth-"));
    const oauthClientFile = join(homeDir, "oauth.json");
    await writeFile(
      oauthClientFile,
      JSON.stringify({
        installed: {
          client_id: "client-id",
          client_secret: "client-secret",
          redirect_uris: ["http://127.0.0.1"],
        },
      }),
    );
    const requested: ConfigSecretStoreOptions[] = [];
    const secretStoreFactory = (options: ConfigSecretStoreOptions) => {
      requested.push(options);
      return {
        get: async () =>
          JSON.stringify({
            access_token: `access-${options.configFile}`,
            refresh_token: `refresh-${options.configFile}`,
            expiry_date: Date.now() + 60 * 60_000,
          }),
        set: async () => undefined,
        delete: async () => undefined,
      };
    };
    const first = await runtimeFixture({
      configFile: join(homeDir, "one.toml"),
      secretStoreFactory,
    });
    const second = await runtimeFixture({
      configFile: join(homeDir, "two.toml"),
      secretStoreFactory,
    });
    for (const fixture of [first, second]) {
      fixture.config.drive.rootFolderId = "root";
      fixture.config.drive.oauthClientFile = oauthClientFile;
      await fixture.runtime.drive();
      fixture.runtime.close();
    }

    expect(requested).toEqual([
      {
        platform: "linux",
        configFile: join(homeDir, "one.toml"),
        legacyAccount: "test-device",
      },
      {
        platform: "linux",
        configFile: join(homeDir, "two.toml"),
        legacyAccount: "test-device",
      },
    ]);
  });

  it("requires backfill for history when no incremental watermark exists", async () => {
    const { runtime, config, paths } = await runtimeFixture();
    const sourcePath = join(
      dirname(config.capture.codexPaths[0]!),
      "sessions",
      "2026",
      "07",
      "18",
      "rollout-test.jsonl",
    );
    config.capture.codexPaths = [
      dirname(dirname(dirname(dirname(sourcePath)))),
    ];
    await mkdir(dirname(sourcePath), { recursive: true });
    await cp(join(fixtures, "codex", "top-level.jsonl"), sourcePath);
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    await utimes(sourcePath, oldTime, oldTime);

    const incremental = await runtime.uploadSessions({
      sources: ["codex"],
      dryRun: true,
      backfill: false,
    });
    const backfill = await runtime.uploadSessions({
      sources: ["codex"],
      dryRun: true,
      backfill: true,
    });

    expect(incremental.scanned).toBe(0);
    expect(backfill.scanned).toBe(1);
    await expect(
      import("node:fs/promises").then(({ access }) => access(paths.stateFile)),
    ).rejects.toThrow();
    runtime.close();
  });

  it("incrementally uploads all four local sources and performs no unchanged writes", async () => {
    const { runtime, config, paths, homeDir } = await runtimeFixture();
    const roots = configureSourceRoots(homeDir, config);
    const drive = new MemoryDrive();
    vi.spyOn(runtime, "drive").mockResolvedValue(drive);
    const baseline = await runtime.uploadSessions({});
    expect(baseline.scanned).toBe(0);
    const baselineState = new SqliteStateStore(paths.stateFile);
    const baselineTime = new Date(
      baselineState.getDiscoveryWatermark("claude-code")!,
    ).getTime();
    baselineState.close();
    const stableMtime = new Date(baselineTime + 1);
    const waitMs = Math.max(0, stableMtime.getTime() - Date.now() + 1);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const sourceFiles = await writeSourceFixtures(roots);
    await Promise.all(
      [
        sourceFiles.claude,
        sourceFiles.codex,
        sourceFiles.grokHistory,
        sourceFiles.cursor,
      ].map((path) => utimes(path, stableMtime, stableMtime)),
    );

    const first = await runtime.uploadSessions({});

    expect(first).toMatchObject({ scanned: 4, uploaded: 4 });
    expect(first.adapters).toMatchObject({
      claude: { captured: 1, malformed: 1, errors: 0 },
      codex: { captured: 1, errors: 0 },
      grok: { captured: 1, errors: 0 },
      cursor: { captured: 1, malformed: 1, errors: 0 },
    });
    const before = await drive.list({ prefix: "inbox/" });
    const state = new SqliteStateStore(paths.stateFile);
    expect(state.getDiscoveryWatermark("claude-code")).not.toBeNull();
    expect(state.getDiscoveryWatermark("codex")).not.toBeNull();
    expect(state.getDiscoveryWatermark("grok-build")).not.toBeNull();
    expect(state.getDiscoveryWatermark("cursor")).not.toBeNull();
    state.close();

    const second = await runtime.uploadSessions({});
    const after = await drive.list({ prefix: "inbox/" });

    expect(second).toMatchObject({ scanned: 0, uploaded: 0, unchanged: 0 });
    expect(after).toEqual(before);
    runtime.close();
  });

  it("advances only successful source watermarks", async () => {
    const { runtime, config, paths, homeDir } = await runtimeFixture();
    const roots = configureSourceRoots(homeDir, config);
    vi.spyOn(runtime, "drive").mockResolvedValue(new MemoryDrive());
    await runtime.uploadSessions({});
    const baselineState = new SqliteStateStore(paths.stateFile);
    const baseline = {
      claude: baselineState.getDiscoveryWatermark("claude-code"),
      codex: baselineState.getDiscoveryWatermark("codex"),
      grok: baselineState.getDiscoveryWatermark("grok-build"),
      cursor: baselineState.getDiscoveryWatermark("cursor"),
    };
    baselineState.close();
    await writeSourceFixtures(roots, { invalidGrokSummary: true });

    const result = await runtime.uploadSessions({});

    expect(result).toMatchObject({ scanned: 3, uploaded: 3 });
    expect(result.adapters).toMatchObject({
      claude: { captured: 1, malformed: 1, errors: 0 },
      codex: { captured: 1, errors: 0 },
      grok: { captured: 0, errors: 1 },
      cursor: { captured: 1, malformed: 1, errors: 0 },
    });
    const state = new SqliteStateStore(paths.stateFile);
    expect(state.getDiscoveryWatermark("claude-code")).not.toBe(
      baseline.claude,
    );
    expect(state.getDiscoveryWatermark("codex")).not.toBe(baseline.codex);
    expect(state.getDiscoveryWatermark("grok-build")).toBe(baseline.grok);
    expect(state.getDiscoveryWatermark("cursor")).not.toBe(baseline.cursor);
    state.close();
    runtime.close();
  });

  it.each(["accepted", "declined"] as const)(
    "does not silently backfill old Cursor history for a legacy %s decision",
    async (decision) => {
      const { runtime, config, paths, homeDir } = await runtimeFixture();
      const roots = configureSourceRoots(homeDir, config);
      const cursor = await writeCursorFixture(
        roots.cursor,
        `legacy-${decision}`,
      );
      const oldTime = new Date("2020-01-01T00:00:00.000Z");
      await utimes(cursor, oldTime, oldTime);
      const legacyState = new SqliteStateStore(paths.stateFile);
      legacyState.recordBackfillDecision({
        decision,
        sessions: 3,
        bytes: 1024,
        decidedAt: "2026-07-28T02:00:00.000Z",
      });
      if (decision === "accepted") {
        legacyState.recordBackfillUpload({
          uploaded: 3,
          pending: 0,
          recordedAt: "2026-07-28T02:01:00.000Z",
        });
      }
      for (const source of ["claude-code", "codex", "grok-build"] as const) {
        legacyState.setDiscoveryWatermark(source, "2026-07-28T02:00:00.000Z");
      }
      legacyState.close();
      const database = new Database(paths.stateFile);
      database
        .prepare("DELETE FROM discovery_watermarks WHERE source = 'cursor'")
        .run();
      database.close();
      const drive = new MemoryDrive();
      vi.spyOn(runtime, "drive").mockResolvedValue(drive);

      const first = await runtime.uploadSessions({ sources: ["cursor"] });
      expect(first).toMatchObject({ scanned: 0, uploaded: 0 });
      const state = new SqliteStateStore(paths.stateFile);
      const cursorWatermark = state.getDiscoveryWatermark("cursor")!;
      state.close();
      expect(cursorWatermark).toBeTruthy();

      await writeFile(
        cursor,
        `${await readFile(cursor, "utf8")}\n{"role":"assistant","message":{"content":[{"type":"text","text":"New Cursor update"}]}}\n`,
      );
      const newTime = new Date(new Date(cursorWatermark).getTime() + 1_000);
      await utimes(cursor, newTime, newTime);

      const second = await runtime.uploadSessions({ sources: ["cursor"] });
      expect(second).toMatchObject({ scanned: 1, uploaded: 1 });
      expect(
        (await drive.list({ prefix: "inbox/" })).some(
          (entry) => entry.appProperties.source === "cursor",
        ),
      ).toBe(true);
      runtime.close();
    },
  );

  it("retries a preprocessing failure even when its file is older than the watermark", async () => {
    const { runtime, config, paths, homeDir } = await runtimeFixture();
    const roots = configureSourceRoots(homeDir, config);
    config.capture.codexPaths = [];
    config.capture.grokPaths = [];
    const drive = new MemoryDrive();
    vi.spyOn(runtime, "drive").mockResolvedValue(drive);
    await runtime.uploadSessions({ sources: ["claude-code"] });
    const { claude } = await writeSourceFixtures(roots);
    const original = await readFile(claude, "utf8");
    const imagePattern = /iVBORw0KGgo[A-Za-z0-9+/=]+/u;
    await writeFile(
      claude,
      original.replace(imagePattern, "not-valid-image-data"),
    );

    const failed = await runtime.uploadSessions({ sources: ["claude-code"] });
    expect(failed.pending).toBe(1);
    expect(failed.warnings).toContainEqual(
      expect.objectContaining({ code: "SESSION_PROCESSING_FAILED" }),
    );
    const state = new SqliteStateStore(paths.stateFile);
    const watermark = state.getDiscoveryWatermark("claude-code")!;
    expect(state.listPending(10)).toHaveLength(1);
    state.close();
    await writeFile(claude, original);
    const oldTime = new Date(new Date(watermark).getTime() - 60_000);
    await utimes(claude, oldTime, oldTime);
    const withoutPending = await runtime.discover({
      sources: ["claude-code"],
      modifiedAfter: { "claude-code": watermark },
    });
    expect(withoutPending.status.claude.discovered).toBe(0);

    const retried = await runtime.uploadSessions({ sources: ["claude-code"] });

    expect(retried).toMatchObject({ scanned: 1, uploaded: 1, pending: 0 });
    runtime.close();
  });
});
