import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clientMutation,
  mergeClaudeDesktopConfig,
} from "../../src/clients/registry.js";

describe("MCP client registration", () => {
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
