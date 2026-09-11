import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ClientRegistry,
  clientMutation,
  launchWithConfig,
  mergeClaudeDesktopConfig,
} from "../../src/clients/registry.js";

describe("MCP client registration", () => {
  it("preserves a custom config path in the registered server launch", () => {
    expect(
      launchWithConfig(
        {
          command: "/usr/local/bin/node",
          args: ["/opt/brain-mcp/dist/cli/index.js"],
        },
        "/custom/config.toml",
      ),
    ).toEqual({
      command: "/usr/local/bin/node",
      args: [
        "/opt/brain-mcp/dist/cli/index.js",
        "--config",
        "/custom/config.toml",
      ],
    });
  });

  it("uses exact argument arrays without shell interpolation", () => {
    const launch = {
      command: "/usr/local/bin/node",
      args: ["/opt/brain-mcp/dist/cli/index.js"],
    };
    expect(clientMutation("claude", "install", launch)).toEqual({
      command: "claude",
      args: [
        "mcp",
        "add",
        "--scope",
        "user",
        "brain-hub",
        "--",
        "/usr/local/bin/node",
        "/opt/brain-mcp/dist/cli/index.js",
        "serve",
      ],
    });
    expect(clientMutation("codex", "install", launch).args).toEqual([
      "mcp",
      "add",
      "brain-hub",
      "--",
      "/usr/local/bin/node",
      "/opt/brain-mcp/dist/cli/index.js",
      "serve",
    ]);
    expect(clientMutation("grok", "install", launch).args).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "brain-hub",
      "--",
      "/usr/local/bin/node",
      "/opt/brain-mcp/dist/cli/index.js",
      "serve",
    ]);
  });

  it("does not overwrite malformed Claude Desktop configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brainhub-client-"));
    const path = join(directory, "claude_desktop_config.json");
    const malformed = '{"mcpServers":';
    await writeFile(path, malformed);

    await expect(
      mergeClaudeDesktopConfig(path, {
        command: "/usr/local/bin/node",
        args: ["/opt/brain-mcp/dist/cli/index.js"],
      }),
    ).rejects.toThrow();

    await expect(readFile(path, "utf8")).resolves.toBe(malformed);
  });
});

describe("Cursor registration", () => {
  it("selects available clients for --all installation and registered clients for removal", async () => {
    const home = await mkdtemp(join(tmpdir(), "brainhub-cursor-"));
    await mkdir(join(home, ".cursor"));
    const registry = new ClientRegistry(
      { command: "node", args: [] },
      async () => {
        throw new Error("CLI not installed");
      },
      home,
    );
    await expect(registry.targets("install")).resolves.toEqual(["cursor"]);
    await expect(registry.targets("uninstall")).resolves.toEqual([]);
    await registry.mutate("cursor", "install");
    await expect(registry.targets("uninstall")).resolves.toEqual(["cursor"]);
  });

  it("merges and removes only BrainHub using the global MCP config without a CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "brainhub-cursor-"));
    const path = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"));
    const original = {
      mcpServers: { other: { command: "other" } },
      custom: true,
    };
    await writeFile(path, JSON.stringify(original));
    const run = vi.fn(async () => {
      throw new Error("CLI not installed");
    });
    const registry = new ClientRegistry(
      { command: "node", args: ["brainhub.js"] },
      run,
      home,
    );
    await expect(registry.status("cursor")).resolves.toEqual({
      available: true,
      registered: false,
    });
    await registry.mutate("cursor", "install");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...original,
      mcpServers: {
        ...original.mcpServers,
        "brain-hub": { command: "node", args: ["brainhub.js", "serve"] },
      },
    });
    await expect(registry.status("cursor")).resolves.toEqual({
      available: true,
      registered: true,
    });
    await registry.mutate("cursor", "uninstall");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not replace malformed Cursor configuration", async () => {
    const home = await mkdtemp(join(tmpdir(), "brainhub-cursor-"));
    const path = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"));
    await writeFile(path, '{"mcpServers": []}');
    const registry = new ClientRegistry(
      { command: "node", args: [] },
      vi.fn(),
      home,
    );
    await expect(registry.mutate("cursor", "install")).rejects.toThrow(
      "mcpServers must be a JSON object",
    );
    expect(await readFile(path, "utf8")).toBe('{"mcpServers": []}');
  });
});
