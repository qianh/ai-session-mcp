import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SchedulerManager } from "../../src/scheduler/manager.js";

describe("scheduler manager", () => {
  it("installs, reports, and removes upload and portrait sync launch agents", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "brainhub-scheduler-"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const manager = new SchedulerManager({
      platform: "darwin",
      homeDir,
      command: "/usr/local/bin/node",
      args: ["/opt/brain-mcp/dist/cli/index.js", "--config", "/tmp/config"],
      runner: async (command, args) => {
        calls.push({ command, args });
      },
    });

    await manager.install("02:00", "06:00");

    const uploadPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.brainhub.upload.plist",
    );
    const syncPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.brainhub.sync.plist",
    );
    await expect(readFile(uploadPath, "utf8")).resolves.toContain(
      "<string>upload</string>",
    );
    await expect(readFile(syncPath, "utf8")).resolves.toContain(
      "<string>pull</string>",
    );
    await expect(manager.status()).resolves.toEqual({
      installed: true,
      upload: { installed: true },
      sync: { installed: true },
      platform: "darwin",
    });
    expect(
      calls.filter(
        ({ command, args }) =>
          command === "launchctl" && args[0] === "bootstrap",
      ),
    ).toHaveLength(2);

    await manager.uninstall();

    await expect(manager.status()).resolves.toEqual({
      installed: false,
      upload: { installed: false },
      sync: { installed: false },
      platform: "darwin",
    });
  });
});
