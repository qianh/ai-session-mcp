import { spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { renderLaunchAgent } from "./launchd.js";
import { renderSystemdUnits } from "./systemd.js";

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

  async install(at: string, syncAt: string): Promise<void> {
    if (this.#platform === "darwin") {
      const directory = join(this.#homeDir, "Library", "LaunchAgents");
      const logs = join(this.#homeDir, "Library", "Logs", "BrainHub");
      const jobs = [
        {
          path: join(directory, "com.brainhub.upload.plist"),
          at,
          job: "upload" as const,
        },
        {
          path: join(directory, "com.brainhub.sync.plist"),
          at: syncAt,
          job: "portrait-sync" as const,
        },
      ];
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
      for (const { path } of jobs) {
        await this.#run("launchctl", ["bootout", domain, path]).catch(
          () => undefined,
        );
        await this.#run("launchctl", ["bootstrap", domain, path]);
      }
      return;
    }
    if (this.#platform !== "linux")
      throw new Error(`Unsupported scheduler platform: ${this.#platform}`);
    const directory = join(this.#homeDir, ".config", "systemd", "user");
    await mkdir(directory, { recursive: true });
    const uploadUnits = renderSystemdUnits({
      command: this.#command,
      args: this.#args,
      at,
    });
    const syncUnits = renderSystemdUnits({
      command: this.#command,
      args: this.#args,
      at: syncAt,
      job: "portrait-sync",
    });
    await Promise.all([
      writeFile(
        join(directory, "brainhub-upload.service"),
        uploadUnits.service,
      ),
      writeFile(join(directory, "brainhub-upload.timer"), uploadUnits.timer),
      writeFile(join(directory, "brainhub-sync.service"), syncUnits.service),
      writeFile(join(directory, "brainhub-sync.timer"), syncUnits.timer),
    ]);
    await this.#run("systemctl", ["--user", "daemon-reload"]);
    await this.#run("systemctl", [
      "--user",
      "enable",
      "--now",
      "brainhub-upload.timer",
      "brainhub-sync.timer",
    ]);
    await this.#run("systemctl", [
      "--user",
      "start",
      "brainhub-upload.service",
    ]);
    await this.#run("systemctl", [
      "--user",
      "start",
      "brainhub-sync.service",
    ]).catch(() => undefined);
  }

  async uninstall(): Promise<void> {
    if (this.#platform === "darwin") {
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
      return;
    }
    await this.#run("systemctl", [
      "--user",
      "disable",
      "--now",
      "brainhub-upload.timer",
      "brainhub-sync.timer",
    ]).catch(() => undefined);
    const directory = join(this.#homeDir, ".config", "systemd", "user");
    await Promise.all([
      rm(join(directory, "brainhub-upload.service"), { force: true }),
      rm(join(directory, "brainhub-upload.timer"), { force: true }),
      rm(join(directory, "brainhub-sync.service"), { force: true }),
      rm(join(directory, "brainhub-sync.timer"), { force: true }),
    ]);
    await this.#run("systemctl", ["--user", "daemon-reload"]);
  }

  async status(): Promise<{
    installed: boolean;
    upload: { installed: boolean };
    sync: { installed: boolean };
    platform: string;
  }> {
    const directory =
      this.#platform === "darwin"
        ? join(this.#homeDir, "Library", "LaunchAgents")
        : join(this.#homeDir, ".config", "systemd", "user");
    const uploadPath = join(
      directory,
      this.#platform === "darwin"
        ? "com.brainhub.upload.plist"
        : "brainhub-upload.timer",
    );
    const syncPath = join(
      directory,
      this.#platform === "darwin"
        ? "com.brainhub.sync.plist"
        : "brainhub-sync.timer",
    );
    const [uploadInstalled, syncInstalled] = await Promise.all([
      access(uploadPath)
        .then(() => true)
        .catch(() => false),
      access(syncPath)
        .then(() => true)
        .catch(() => false),
    ]);
    return {
      installed: uploadInstalled && syncInstalled,
      upload: { installed: uploadInstalled },
      sync: { installed: syncInstalled },
      platform: this.#platform,
    };
  }
}
