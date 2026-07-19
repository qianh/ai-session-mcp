import { describe, expect, it } from "vitest";

import {
  createDefaultConfig,
  mergeConfigLayers,
  platformPaths,
} from "../../src/domain/config.js";

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
      drive: { rootFolderName: "brain-hub" },
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
});
