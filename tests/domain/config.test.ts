import { lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDefaultConfig,
  mergeConfigLayers,
  platformPaths,
} from "../../src/domain/config.js";
import { loadConfig, writeConfig } from "../../src/domain/config-io.js";

describe("configuration", () => {
  it("uses the frozen macOS paths and defaults", () => {
    const paths = platformPaths({ platform: "darwin", homeDir: "/Users/test" });
    const config = createDefaultConfig({
      hostname: "macbook",
      homeDir: "/Users/test",
      platform: "darwin",
    });

    expect(paths.configFile).toBe(
      "/Users/test/Library/Application Support/BrainHub/config.toml",
    );
    expect(paths.stateFile).toBe(
      "/Users/test/Library/Application Support/BrainHub/state.sqlite",
    );
    expect(paths.modelCache).toBe("/Users/test/Library/Caches/BrainHub/models");
    expect(config).toMatchObject({
      version: 1,
      device: { name: "macbook" },
      drive: {
        rootFolderId: "",
        rootFolderName: "brain-hub",
        accountEmail: "",
        accountDisplayName: "",
        accountPermissionId: "",
      },
      capture: { includeSubagents: false },
      upload: { batchSize: 100, concurrency: 4 },
      search: {
        dimensions: 384,
        chunkTokens: 448,
        chunkOverlap: 64,
        defaultLimit: 10,
        maxLimit: 50,
      },
      scheduler: { at: "02:00" },
    });
  });

  it("loads legacy version 1 TOML without account binding fields", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "brainhub-config-"));
    const configFile = join(homeDir, "legacy.toml");
    await writeFile(
      configFile,
      [
        "version = 1",
        "",
        "[device]",
        'name = "legacy-device"',
        "",
        "[drive]",
        'root_folder_id = "legacy-root"',
        'root_folder_name = "brain-hub"',
        'oauth_client_file = "oauth.json"',
      ].join("\n"),
    );

    const loaded = await loadConfig({
      homeDir,
      hostname: "unused",
      platform: "linux",
      configFile,
      env: {},
    });

    expect(loaded.config.drive).toMatchObject({
      rootFolderId: "legacy-root",
      accountEmail: "",
      accountDisplayName: "",
      accountPermissionId: "",
    });
  });

  it("resolves CLI over env over file over defaults", () => {
    const defaults = createDefaultConfig({
      hostname: "default-host",
      homeDir: "/home/test",
      platform: "linux",
    });
    const resolved = mergeConfigLayers(defaults, {
      file: { device: { name: "file-host" }, upload: { batchSize: 25 } },
      env: { device: { name: "env-host" }, upload: { concurrency: 2 } },
      cli: { device: { name: "cli-host" } },
    });

    expect(resolved.device.name).toBe("cli-host");
    expect(resolved.upload).toEqual({ batchSize: 25, concurrency: 2 });
  });

  it("rejects unsafe limits and invalid schedule times", () => {
    const defaults = createDefaultConfig({
      hostname: "host",
      homeDir: "/home/test",
      platform: "linux",
    });

    expect(() =>
      mergeConfigLayers(defaults, {
        cli: { search: { defaultLimit: 51, maxLimit: 50 } },
      }),
    ).toThrow();
    expect(() =>
      mergeConfigLayers(defaults, { cli: { scheduler: { at: "25:00" } } }),
    ).toThrow();
  });

  it("preserves a config symlink while atomically updating its target", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "brainhub-config-link-"));
    const targetFile = join(homeDir, "managed-config.toml");
    const configFile = join(homeDir, "config.toml");
    await writeFile(targetFile, "previous content");
    await symlink(targetFile, configFile);
    const config = createDefaultConfig({
      hostname: "linked-device",
      homeDir,
      platform: process.platform,
    });

    await writeConfig(configFile, config);

    expect((await lstat(configFile)).isSymbolicLink()).toBe(true);
    expect(await readFile(targetFile, "utf8")).toContain(
      'name = "linked-device"',
    );
  });
});
