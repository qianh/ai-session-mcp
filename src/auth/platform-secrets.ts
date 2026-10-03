import { spawn } from "node:child_process";

import { BrainHubError } from "../domain/errors.js";
import { assertSupportedPlatform } from "../domain/platform.js";
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
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        const error = new Error(
          `${command} exited with ${code}: ${detail}`,
        ) as Error & { exitCode: number | null; stderr: string };
        error.exitCode = code;
        error.stderr = detail;
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
    this.#service = options.service ?? "brainhub-mcp-google-oauth";
    this.#account = options.account;
    this.#runner = options.runner ?? defaultRunner;
    assertSupportedPlatform(this.#platform);
  }

  async probe(): Promise<void> {
    if (this.#platform !== "linux") return;
    try {
      await this.#runner("secret-tool", ["search", "service", this.#service]);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") {
        throw new BrainHubError(
          "SECRET_STORE_UNAVAILABLE",
          "secret-tool is not installed. On Arch Linux, install libsecret and a Secret Service provider such as gnome-keyring.",
        );
      }
      throw new BrainHubError(
        "SECRET_STORE_UNAVAILABLE",
        `Secret Service is unavailable. Start gnome-keyring or kwallet, then rerun setup. ${secretToolStderr(error) || "unknown error"}`,
        true,
      );
    }
  }

  async get(): Promise<string | null> {
    if (this.#platform === "linux") {
      try {
        const output = await this.#runner("secret-tool", [
          "lookup",
          "service",
          this.#service,
          "account",
          this.#account,
        ]);
        return output.trim() || null;
      } catch (error) {
        if (isAbsentSecretToolItem(error)) return null;
        throw secretServiceUnavailable(error);
      }
    }
    try {
      const output = await this.#runner("security", [
        "find-generic-password",
        "-s",
        this.#service,
        "-a",
        this.#account,
        "-w",
      ]);
      return output.trim() || null;
    } catch {
      return null;
    }
  }

  async set(value: string): Promise<void> {
    if (this.#platform === "linux") {
      await this.#runner(
        "secret-tool",
        [
          "store",
          "--label",
          "BrainHub MCP Google OAuth",
          "service",
          this.#service,
          "account",
          this.#account,
        ],
        value,
      );
      return;
    }
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
  }

  async delete(): Promise<void> {
    try {
      if (this.#platform === "linux") {
        await this.#runner("secret-tool", [
          "clear",
          "service",
          this.#service,
          "account",
          this.#account,
        ]);
        return;
      }
      await this.#runner("security", [
        "delete-generic-password",
        "-s",
        this.#service,
        "-a",
        this.#account,
      ]);
    } catch (error) {
      const exitCode = (error as { exitCode?: unknown }).exitCode;
      if (this.#platform === "darwin" && exitCode === 44) return;
      if (this.#platform === "linux" && isAbsentSecretToolItem(error)) return;
      throw error;
    }
  }
}

// secret-tool exits 1 without stderr when no item matches; every D-Bus,
// locked-collection, or prompt failure prints a reason to stderr.
function isAbsentSecretToolItem(error: unknown): boolean {
  if ((error as { exitCode?: unknown }).exitCode !== 1) return false;
  return secretToolStderr(error) === "";
}

function secretToolStderr(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === "string") return stderr.trim();
  const message = error instanceof Error ? error.message : "";
  return message.replace(/^secret-tool exited with -?\d+:/, "").trim();
}

function secretServiceUnavailable(error: unknown): BrainHubError {
  const detail =
    (error as { code?: unknown }).code === "ENOENT"
      ? "secret-tool is not installed"
      : secretToolStderr(error) || "unknown error";
  return new BrainHubError(
    "SECRET_STORE_UNAVAILABLE",
    `Secret Service could not read the BrainHub credential. Unlock gnome-keyring or kwallet for this session, then retry. ${detail}`,
    true,
  );
}
