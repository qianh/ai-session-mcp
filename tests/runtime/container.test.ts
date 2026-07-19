import { cp, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultConfig, platformPaths } from "../../src/domain/config.js";
import { BrainHubRuntime } from "../../src/runtime/container.js";

const fixtures = resolve(import.meta.dirname, "..", "fixtures");

async function runtimeFixture() {
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
      homeDir,
      platform: "linux",
      executable: process.execPath,
      executableArgs: [resolve("dist/cli/index.js")],
    }),
  };
}

describe("BrainHub runtime", () => {
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
