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

  async install(at: string): Promise<void> {
    if (this.#platform === "darwin") {
      const directory = join(this.#homeDir, "Library", "LaunchAgents");
      const logs = join(this.#homeDir, "Library", "Logs", "BrainHub");
      const path = join(directory, "com.brainhub.upload.plist");
      await Promise.all([
        mkdir(directory, { recursive: true }),
        mkdir(logs, { recursive: true }),
      ]);
      await writeFile(
        path,
        renderLaunchAgent({
          command: this.#command,
          args: this.#args,
          at,
          logDirectory: logs,
        }),
      );
      const domain = `gui/${process.getuid?.() ?? 0}`;
      await this.#run("launchctl", ["bootout", domain, path]).catch(
        () => undefined,
      );
      await this.#run("launchctl", ["bootstrap", domain, path]);
      return;
    }
    if (this.#platform !== "linux")
      throw new Error(`Unsupported scheduler platform: ${this.#platform}`);
    const directory = join(this.#homeDir, ".config", "systemd", "user");
    await mkdir(directory, { recursive: true });
    const units = renderSystemdUnits({
      command: this.#command,
      args: this.#args,
      at,
    });
    await Promise.all([
      writeFile(join(directory, "brainhub-upload.service"), units.service),
      writeFile(join(directory, "brainhub-upload.timer"), units.timer),
    ]);
    await this.#run("systemctl", ["--user", "daemon-reload"]);
    await this.#run("systemctl", [
      "--user",
      "enable",
      "--now",
      "brainhub-upload.timer",
    ]);
    await this.#run("systemctl", [
      "--user",
      "start",
      "brainhub-upload.service",
    ]);
  }

  async uninstall(): Promise<void> {
    if (this.#platform === "darwin") {
      const path = join(
        this.#homeDir,
        "Library",
        "LaunchAgents",
        "com.brainhub.upload.plist",
      );
      await this.#run("launchctl", [
        "bootout",
        `gui/${process.getuid?.() ?? 0}`,
        path,
      ]).catch(() => undefined);
      await rm(path, { force: true });
      return;
    }
    await this.#run("systemctl", [
      "--user",
      "disable",
      "--now",
      "brainhub-upload.timer",
    ]).catch(() => undefined);
    const directory = join(this.#homeDir, ".config", "systemd", "user");
    await Promise.all([
      rm(join(directory, "brainhub-upload.service"), { force: true }),
      rm(join(directory, "brainhub-upload.timer"), { force: true }),
    ]);
    await this.#run("systemctl", ["--user", "daemon-reload"]);
  }

  async status(): Promise<{ installed: boolean; platform: string }> {
    const path =
      this.#platform === "darwin"
        ? join(
            this.#homeDir,
            "Library",
            "LaunchAgents",
            "com.brainhub.upload.plist",
          )
        : join(
            this.#homeDir,
            ".config",
            "systemd",
            "user",
            "brainhub-upload.timer",
          );
    const installed = await access(path)
      .then(() => true)
      .catch(() => false);
    return { installed, platform: this.#platform };
  }
}
