import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { BrainHubError } from "../domain/errors.js";
import type { CommandSpec } from "../runtime/command.js";

export type ClientName = "claude" | "codex" | "grok";
export type ClientAction = "install" | "uninstall";

export function clientMutation(
  client: ClientName,
  action: ClientAction,
  launch: CommandSpec,
): { command: string; args: string[] } {
  if (action === "install") {
    const prefix =
      client === "codex"
        ? ["mcp", "add", "brain-hub", "--"]
        : ["mcp", "add", "--scope", "user", "brain-hub", "--"];
    return {
      command: client,
      args: [...prefix, launch.command, ...launch.args, "serve"],
    };
  }
  return client === "claude"
    ? {
        command: client,
        args: ["mcp", "remove", "--scope", "user", "brain-hub"],
      }
    : { command: client, args: ["mcp", "remove", "brain-hub"] };
}

type Runner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; exitCode: number }>;

const defaultRunner: Runner = async (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolve({
        stdout: Buffer.concat(output).toString("utf8"),
        exitCode: exitCode ?? 1,
      }),
    );
  });

export class ClientRegistry {
  constructor(
    readonly launch: CommandSpec,
    readonly run: Runner = defaultRunner,
  ) {}

  async mutate(client: ClientName, action: ClientAction): Promise<void> {
    if (action === "install") {
      const help = await this.run(client, ["mcp", "add", "--help"]);
      if (help.exitCode !== 0 || !help.stdout.includes("--")) {
        throw new BrainHubError(
          "CLIENT_VERSION_UNSUPPORTED",
          `${client} does not support the required MCP syntax`,
        );
      }
    }
    const mutation = clientMutation(client, action, this.launch);
    const result = await this.run(mutation.command, mutation.args);
    if (result.exitCode !== 0)
      throw new Error(`${client} MCP ${action} failed`);
  }

  async status(
    client: ClientName,
  ): Promise<{ available: boolean; registered: boolean }> {
    try {
      const result = await this.run(client, ["mcp", "list"]);
      return {
        available: result.exitCode === 0,
        registered: result.stdout.includes("brain-hub"),
      };
    } catch {
      return { available: false, registered: false };
    }
  }
}

export async function mergeClaudeDesktopConfig(
  path: string,
  launch: CommandSpec,
): Promise<string> {
  let config: Record<string, unknown> = {};
  let source: string | null = null;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (source !== null) {
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Claude Desktop configuration must be a JSON object");
    }
    config = parsed as Record<string, unknown>;
    const backup = `${path}.backup-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
    await copyFile(path, backup);
  }
  const servers =
    config.mcpServers && typeof config.mcpServers === "object"
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  config.mcpServers = {
    ...servers,
    "brain-hub": {
      command: launch.command,
      args: [...launch.args, "serve"],
    },
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return path;
}
