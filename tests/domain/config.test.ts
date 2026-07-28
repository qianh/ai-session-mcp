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
      scheduler: { at: "02:00", syncAt: "06:00" },
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

  it("scopes upload and search state to the active Drive binding", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "brainhub-config-"));
    const loadBinding = async (permissionId: string, rootFolderId: string) => {
      const configFile = join(homeDir, `${permissionId}-${rootFolderId}.toml`);
      const config = createDefaultConfig({
        hostname: "macbook",
        homeDir,
        platform: "darwin",
      });
      config.drive.accountPermissionId = permissionId;
      config.drive.rootFolderId = rootFolderId;
      await writeConfig(configFile, config);
      return loadConfig({
        homeDir,
        hostname: "macbook",
        platform: "darwin",
        configFile,
        env: {},
      });
    };

    const first = await loadBinding("permission-a", "root-a");
    const second = await loadBinding("permission-b", "root-b");
    const rebound = await loadBinding("permission-a", "root-c");

    expect(first.paths.stateFile).not.toBe(second.paths.stateFile);
    expect(first.paths.searchIndexFile).not.toBe(second.paths.searchIndexFile);
    expect(first.paths.stateFile).not.toBe(rebound.paths.stateFile);
    expect(first.paths.searchIndexFile).not.toBe(rebound.paths.searchIndexFile);
    expect(first.paths.stateFile).toContain("/accounts/");
    expect(first.paths.stateFile).not.toContain("permission-a");
    expect(first.paths.modelCache).toBe(second.paths.modelCache);
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
    expect(() =>
      mergeConfigLayers(defaults, {
        cli: { scheduler: { syncAt: "25:00" } },
      }),
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
