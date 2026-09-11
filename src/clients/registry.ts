import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { BrainHubError } from "../domain/errors.js";
import type { CommandSpec } from "../runtime/command.js";
import { installBrainHubSkills, uninstallBrainHubSkills } from "./skills.js";

export const CLIENT_NAMES = ["claude", "codex", "grok", "cursor"] as const;
export type ClientName = (typeof CLIENT_NAMES)[number];
export type ClientAction = "install" | "uninstall";

export function launchWithConfig(
  launch: CommandSpec,
  configFile: string,
): CommandSpec {
  return {
    command: launch.command,
    args: [...launch.args, "--config", configFile],
  };
}

export function clientMutation(
  client: Exclude<ClientName, "cursor">,
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
    readonly homeDir: string = homedir(),
  ) {}

  async targets(action: ClientAction): Promise<ClientName[]> {
    const statuses = await Promise.all(
      CLIENT_NAMES.map((client) => this.status(client)),
    );
    return CLIENT_NAMES.filter((_, index) =>
      action === "install"
        ? statuses[index]!.available
        : statuses[index]!.registered,
    );
  }

  async mutate(client: ClientName, action: ClientAction): Promise<void> {
    if (client === "cursor") {
      await this.mutateCursor(action);
      if (action === "install") await this.installSkills(client);
      else await this.uninstallSkills(client);
      return;
    }
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
    if (action === "install") await this.installSkills(client);
    else await this.uninstallSkills(client);
  }

  installSkills(client: ClientName): Promise<void> {
    return installBrainHubSkills(client, this.homeDir);
  }

  uninstallSkills(client: ClientName): Promise<void> {
    return uninstallBrainHubSkills(client, this.homeDir);
  }

  private async cursorConfig(): Promise<Record<string, unknown>> {
    let source: string;
    try {
      source = await readFile(
        join(this.homeDir, ".cursor", "mcp.json"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const config: unknown = JSON.parse(source);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError("Cursor configuration must be a JSON object");
    }
    const result = config as Record<string, unknown>;
    if (
      result.mcpServers !== undefined &&
      (!result.mcpServers ||
        typeof result.mcpServers !== "object" ||
        Array.isArray(result.mcpServers))
    ) {
      throw new TypeError("mcpServers must be a JSON object");
    }
    return result;
  }

  private async mutateCursor(action: ClientAction): Promise<void> {
    const config = await this.cursorConfig();
    const servers = {
      ...(config.mcpServers as Record<string, unknown> | undefined),
    };
    if (action === "install") {
      servers["brain-hub"] = {
        command: this.launch.command,
        args: [...this.launch.args, "serve"],
      };
    } else {
      if (!Object.hasOwn(servers, "brain-hub")) return;
      delete servers["brain-hub"];
    }
    config.mcpServers = servers;
    const path = join(this.homeDir, ".cursor", "mcp.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  async status(
    client: ClientName,
  ): Promise<{ available: boolean; registered: boolean }> {
    if (client === "cursor") {
      let available = false;
      try {
        available = (await stat(join(this.homeDir, ".cursor"))).isDirectory();
      } catch {
        // Cursor can be installed without a global configuration directory yet.
      }
      if (!available) {
        try {
          available = (await this.run("cursor", ["--version"])).exitCode === 0;
        } catch {
          /* CLI is optional. */
        }
      }
      try {
        const config = await this.cursorConfig();
        return {
          available,
          registered: Object.hasOwn(
            (config.mcpServers ?? {}) as object,
            "brain-hub",
          ),
        };
      } catch {
        return { available, registered: false };
      }
    }
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
