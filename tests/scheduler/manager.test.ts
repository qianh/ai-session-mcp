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
      "<string>upload</string>\n<string>--sources</string>\n<string>claude-code,codex,grok-build</string>",
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
      "<string>upload</string>\n    <string>--json</string>",
    );
    await expect(readFile(uploadPath, "utf8")).resolves.not.toContain(
      "claude-code,codex,grok-build",
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

  it("installs, reports, and removes systemd user timers", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "brainhub-systemd-"));
    const directory = join(homeDir, ".config", "systemd", "user");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "brainhub-upload.service"),
      "ExecStart=obsolete --sources claude-code,codex,grok-build\n",
    );
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

    await manager.install("03:17", "06:23");

    const service = await readFile(
      join(directory, "brainhub-upload.service"),
      "utf8",
    );
    const timer = await readFile(
      join(directory, "brainhub-upload.timer"),
      "utf8",
    );
    const syncService = await readFile(
      join(directory, "brainhub-sync.service"),
      "utf8",
    );
    expect(service).toContain("Type=oneshot");
    expect(service).toContain(
      "ExecStart=/usr/bin/node /opt/brain-mcp/dist/cli/index.js --config /tmp/config upload --json",
    );
    expect(service).not.toContain("obsolete");
    expect(service).not.toContain("--sources");
    expect(timer).toContain("OnCalendar=*-*-* 03:17:00");
    expect(timer).toContain("Persistent=true");
    expect(syncService).toContain("portrait sync --json");
    expect(calls).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      {
        command: "systemctl",
        args: ["--user", "enable", "--now", "brainhub-upload.timer"],
      },
      {
        command: "systemctl",
        args: ["--user", "enable", "--now", "brainhub-sync.timer"],
      },
    ]);
    await expect(manager.status()).resolves.toEqual({
      installed: true,
      upload: { installed: true },
      sync: { installed: true },
      platform: "linux",
    });

    await manager.install("03:17", "06:23", { portrait: false });
    await expect(manager.status()).resolves.toMatchObject({
      upload: { installed: true },
      sync: { installed: false },
    });

    await manager.uninstall();
    await expect(manager.status()).resolves.toEqual({
      installed: false,
      upload: { installed: false },
      sync: { installed: false },
      platform: "linux",
    });
    expect(calls.at(-1)).toEqual({
      command: "systemctl",
      args: ["--user", "daemon-reload"],
    });
  });

  it("rejects scheduler installation outside macOS and Linux", async () => {
    const manager = new SchedulerManager({
      platform: "win32",
      homeDir: await mkdtemp(join(tmpdir(), "brainhub-win-")),
      command: "node",
      args: [],
      runner: async () => undefined,
    });

    await expect(manager.install("02:00", "06:00")).rejects.toThrow(
      "BrainHub MCP supports macOS and Linux",
    );
    await expect(manager.uninstall()).rejects.toThrow(
      "BrainHub MCP supports macOS and Linux",
    );
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
