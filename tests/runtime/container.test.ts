import { cp, mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { SecretStore } from "../../src/auth/secret-store.js";
import type { ConfigSecretStoreOptions } from "../../src/auth/secret-store-factory.js";
import { createDefaultConfig, platformPaths } from "../../src/domain/config.js";
import {
  BrainHubRuntime,
  shouldRefreshSearchIndex,
} from "../../src/runtime/container.js";

const fixtures = resolve(import.meta.dirname, "..", "fixtures");

async function runtimeFixture(
  options: {
    configFile?: string;
    secretStoreFactory?: (options: ConfigSecretStoreOptions) => SecretStore;
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
    }),
  };
}

describe("BrainHub runtime", () => {
  it("allows a backfill to skip automatic search indexing", () => {
    expect(shouldRefreshSearchIndex(10, false)).toBe(true);
    expect(shouldRefreshSearchIndex(10, true)).toBe(false);
    expect(shouldRefreshSearchIndex(0, false)).toBe(false);
  });

  it("returns local hub status when Drive is not configured", async () => {
    const { runtime } = await runtimeFixture();

    const result = await runtime.hubStatus();

    expect(result.drive).toEqual({ reachable: false });
    expect(result.adapters).toMatchObject({
      claude: { discovered: 0 },
      codex: { discovered: 0 },
      grok: { discovered: 0 },
    });
    expect(result.scheduler).toMatchObject({
      installed: false,
      platform: "linux",
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "DRIVE_UNAVAILABLE" }),
    );
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
});
