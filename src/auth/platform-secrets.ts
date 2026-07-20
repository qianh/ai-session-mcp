import { spawn } from "node:child_process";

import type { SecretStore } from "./secret-store.js";

export type CommandRunner = (
  command: string,
  args: string[],
  input?: string,
) => Promise<string>;

const defaultRunner: CommandRunner = async (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else {
        const error = new Error(
          `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ) as Error & { exitCode: number | null };
        error.exitCode = code;
        reject(error);
      }
    });
    child.stdin.end(input);
  });

export class PlatformSecretStore implements SecretStore {
  readonly #platform: NodeJS.Platform;
  readonly #service: string;
  readonly #account: string;
  readonly #runner: CommandRunner;

  constructor(options: {
    platform?: NodeJS.Platform;
    service?: string;
    account: string;
    runner?: CommandRunner;
  }) {
    this.#platform = options.platform ?? process.platform;
    this.#service = options.service ?? "brain-mcp-google-oauth";
    this.#account = options.account;
    this.#runner = options.runner ?? defaultRunner;
    if (this.#platform !== "darwin" && this.#platform !== "linux") {
      throw new Error(`Unsupported secret store platform: ${this.#platform}`);
    }
  }

  async get(): Promise<string | null> {
    try {
      const output =
        this.#platform === "darwin"
          ? await this.#runner("security", [
              "find-generic-password",
              "-s",
              this.#service,
              "-a",
              this.#account,
              "-w",
            ])
          : await this.#runner("secret-tool", [
              "lookup",
              "service",
              this.#service,
              "account",
              this.#account,
            ]);
      return output.trim() || null;
    } catch {
      return null;
    }
  }

  async set(value: string): Promise<void> {
    if (this.#platform === "darwin") {
      await this.#runner("security", [
        "add-generic-password",
        "-U",
        "-s",
        this.#service,
        "-a",
        this.#account,
        "-w",
        value,
      ]);
      return;
    }
    await this.#runner(
      "secret-tool",
      [
        "store",
        `--label=BrainHub Google OAuth`,
        "service",
        this.#service,
        "account",
        this.#account,
      ],
      value,
    );
  }

  async delete(): Promise<void> {
    try {
      if (this.#platform === "darwin") {
        await this.#runner("security", [
          "delete-generic-password",
          "-s",
          this.#service,
          "-a",
          this.#account,
        ]);
      } else {
        await this.#runner("secret-tool", [
          "clear",
          "service",
          this.#service,
          "account",
          this.#account,
        ]);
      }
    } catch (error) {
      const exitCode = (error as { exitCode?: unknown }).exitCode;
      if (this.#platform === "darwin" && exitCode === 44) return;
      throw error;
    }
  }
}
