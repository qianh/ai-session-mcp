import { spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BrainHubError } from "../domain/errors.js";
import { renderLaunchAgent } from "./launchd.js";

type Runner = (command: string, args: string[]) => Promise<void>;

const runner: Runner = async (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    );
  });

export class SchedulerManager {
  readonly #platform: NodeJS.Platform;
  readonly #homeDir: string;
  readonly #command: string;
  readonly #args: string[];
  readonly #run: Runner;

  constructor(options: {
    platform?: NodeJS.Platform;
    homeDir: string;
    command: string;
    args: string[];
    runner?: Runner;
  }) {
    this.#platform = options.platform ?? process.platform;
    this.#homeDir = options.homeDir;
    this.#command = options.command;
    this.#args = options.args;
    this.#run = options.runner ?? runner;
  }

  async install(
    at: string,
    syncAt: string,
    options: { portrait?: boolean } = {},
  ): Promise<void> {
    if (this.#platform !== "darwin") {
      throw new BrainHubError(
        "PLATFORM_UNSUPPORTED",
        "BrainHub MCP v1 supports macOS only",
      );
    }
    const directory = join(this.#homeDir, "Library", "LaunchAgents");
    const logs = join(this.#homeDir, "Library", "Logs", "BrainHub");
    const jobs: Array<{
      path: string;
      at: string;
      job: "upload" | "portrait-sync";
    }> = [
      {
        path: join(directory, "com.brainhub.upload.plist"),
        at,
        job: "upload" as const,
      },
    ];
    const syncPath = join(directory, "com.brainhub.sync.plist");
    if (options.portrait !== false) {
      jobs.push({
        path: syncPath,
        at: syncAt,
        job: "portrait-sync",
      });
    }
    await Promise.all([
      mkdir(directory, { recursive: true }),
      mkdir(logs, { recursive: true }),
    ]);
    await Promise.all(
      jobs.map(({ path, ...jobOptions }) =>
        writeFile(
          path,
          renderLaunchAgent({
            command: this.#command,
            args: this.#args,
            logDirectory: logs,
            ...jobOptions,
          }),
        ),
      ),
    );
    const domain = `gui/${process.getuid?.() ?? 0}`;
    if (options.portrait === false) {
      await this.#run("launchctl", ["bootout", domain, syncPath]).catch(
        () => undefined,
      );
      await rm(syncPath, { force: true });
    }
    for (const { path } of jobs) {
      await this.#run("launchctl", ["bootout", domain, path]).catch(
        () => undefined,
      );
      await this.#run("launchctl", ["bootstrap", domain, path]);
    }
  }

  async uninstall(): Promise<void> {
    if (this.#platform !== "darwin") {
      throw new BrainHubError(
        "PLATFORM_UNSUPPORTED",
        "BrainHub MCP v1 supports macOS only",
      );
    }
    const directory = join(this.#homeDir, "Library", "LaunchAgents");
    const paths = [
      join(directory, "com.brainhub.upload.plist"),
      join(directory, "com.brainhub.sync.plist"),
    ];
    for (const path of paths) {
      await this.#run("launchctl", [
        "bootout",
        `gui/${process.getuid?.() ?? 0}`,
        path,
      ]).catch(() => undefined);
      await rm(path, { force: true });
    }
  }

  async status(): Promise<{
    installed: boolean;
    upload: { installed: boolean };
    sync: { installed: boolean };
    platform: string;
  }> {
    if (this.#platform !== "darwin") {
      return {
        installed: false,
        upload: { installed: false },
        sync: { installed: false },
        platform: this.#platform,
      };
    }
    const directory = join(this.#homeDir, "Library", "LaunchAgents");
    const uploadPath = join(directory, "com.brainhub.upload.plist");
    const syncPath = join(directory, "com.brainhub.sync.plist");
    const [uploadInstalled, syncInstalled] = await Promise.all([
      access(uploadPath)
        .then(() => true)
        .catch(() => false),
      access(syncPath)
        .then(() => true)
        .catch(() => false),
    ]);
    return {
      installed: uploadInstalled,
      upload: { installed: uploadInstalled },
      sync: { installed: syncInstalled },
      platform: this.#platform,
    };
  }
}
