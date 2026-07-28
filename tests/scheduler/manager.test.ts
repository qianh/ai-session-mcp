import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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

    const launchAgentDirectory = join(homeDir, "Library", "LaunchAgents");
    await mkdir(launchAgentDirectory, { recursive: true });
    await writeFile(
      join(launchAgentDirectory, "com.brainhub.upload.plist"),
      "obsolete upload job",
    );

    await manager.install("02:00", "06:00");
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
      "<string>upload</string>\n    <string>--sources</string>\n    <string>claude-code,codex,grok-build</string>",
    );
    await expect(readFile(syncPath, "utf8")).resolves.toContain(
      "<string>sync</string>",
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
    ).toHaveLength(4);

    await manager.uninstall();

    await expect(manager.status()).resolves.toEqual({
      installed: false,
      upload: { installed: false },
      sync: { installed: false },
      platform: "darwin",
    });
  });

  it("rejects scheduler installation outside macOS", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "brainhub-systemd-"));
    const directory = join(homeDir, ".config", "systemd", "user");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "brainhub-upload.service"), "obsolete");
    const calls: Array<{ command: string; args: string[] }> = [];
    const manager = new SchedulerManager({
      platform: "linux",
      homeDir,
      command: "/usr/bin/node",
      args: ["/opt/brain-mcp/dist/cli/index.js", "--config", "/tmp/config"],
      runner: async (command, args) => {
        calls.push({ command, args });
      },
    });

    await expect(manager.install("03:17", "06:23")).rejects.toThrow(
      "BrainHub MCP v1 supports macOS only",
    );
    expect(calls).toEqual([]);
  });

  it("can install the upload job without an Obsidian portrait job", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "brainhub-scheduler-"));
    const manager = new SchedulerManager({
      platform: "darwin",
      homeDir,
      command: "/usr/local/bin/node",
      args: ["/opt/brainhub-mcp/dist/cli/index.js"],
      runner: async () => undefined,
    });

    await manager.install("02:00", "06:00", { portrait: false });

    await expect(manager.status()).resolves.toEqual({
      installed: true,
      upload: { installed: true },
      sync: { installed: false },
      platform: "darwin",
    });
  });
});
