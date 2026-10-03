import { spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertSupportedPlatform } from "../domain/platform.js";
import { renderLaunchAgent } from "./launchd.js";
import {
  renderSystemdService,
  renderSystemdTimer,
  systemdUnitBase,
  type ScheduledJob,
} from "./systemd.js";

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
  readonly #xdgConfigHome: string | undefined;
  readonly #command: string;
  readonly #args: string[];
  readonly #run: Runner;

  constructor(options: {
    platform?: NodeJS.Platform;
    homeDir: string;
    xdgConfigHome?: string;
    command: string;
    args: string[];
    runner?: Runner;
  }) {
    this.#platform = options.platform ?? process.platform;
    this.#homeDir = options.homeDir;
    this.#xdgConfigHome = options.xdgConfigHome;
    this.#command = options.command;
    this.#args = options.args;
    this.#run = options.runner ?? runner;
  }

  async install(
    at: string,
    syncAt: string,
    options: { portrait?: boolean } = {},
  ): Promise<void> {
    assertSupportedPlatform(this.#platform);
    if (this.#platform === "linux") {
      await this.#installSystemd(at, syncAt, options);
      return;
    }
    await this.#installLaunchd(at, syncAt, options);
  }

  async uninstall(): Promise<void> {
    assertSupportedPlatform(this.#platform);
    if (this.#platform === "linux") {
      await this.#uninstallSystemd();
      return;
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
    if (this.#platform !== "darwin" && this.#platform !== "linux") {
      return {
        installed: false,
        upload: { installed: false },
        sync: { installed: false },
        platform: this.#platform,
      };
    }
    const paths = this.#markerPaths();
    const [uploadInstalled, syncInstalled] = await Promise.all([
      access(paths.upload)
        .then(() => true)
        .catch(() => false),
      access(paths.sync)
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

  async #installLaunchd(
    at: string,
    syncAt: string,
    options: { portrait?: boolean },
  ): Promise<void> {
    const directory = join(this.#homeDir, "Library", "LaunchAgents");
    const logs = join(this.#homeDir, "Library", "Logs", "BrainHub");
    const jobs: Array<{
      path: string;
      at: string;
      job: ScheduledJob;
    }> = [
      {
        path: join(directory, "com.brainhub.upload.plist"),
        at,
        job: "upload",
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

  async #installSystemd(
    at: string,
    syncAt: string,
    options: { portrait?: boolean },
  ): Promise<void> {
    const directory = this.#systemdDirectory();
    const jobs: Array<{ at: string; job: ScheduledJob }> = [
      { at, job: "upload" },
    ];
    if (options.portrait !== false) {
      jobs.push({ at: syncAt, job: "portrait-sync" });
    }
    await mkdir(directory, { recursive: true });
    await Promise.all(
      jobs.map(async (job) => {
        const base = systemdUnitBase(job.job);
        await writeFile(
          join(directory, `${base}.service`),
          renderSystemdService({
            command: this.#command,
            args: this.#args,
            job: job.job,
          }),
        );
        await writeFile(
          join(directory, `${base}.timer`),
          renderSystemdTimer(job),
        );
      }),
    );
    if (options.portrait === false) {
      await this.#disableSystemdTimer("brainhub-sync");
      await rm(join(directory, "brainhub-sync.service"), { force: true });
      await rm(join(directory, "brainhub-sync.timer"), { force: true });
    }
    await this.#run("systemctl", ["--user", "daemon-reload"]);
    for (const job of jobs) {
      await this.#run("systemctl", [
        "--user",
        "enable",
        "--now",
        `${systemdUnitBase(job.job)}.timer`,
      ]);
    }
  }

  async #uninstallSystemd(): Promise<void> {
    const directory = this.#systemdDirectory();
    for (const base of ["brainhub-upload", "brainhub-sync"]) {
      await this.#disableSystemdTimer(base);
      await rm(join(directory, `${base}.service`), { force: true });
      await rm(join(directory, `${base}.timer`), { force: true });
    }
    await this.#run("systemctl", ["--user", "daemon-reload"]);
  }

  async #disableSystemdTimer(base: string): Promise<void> {
    await this.#run("systemctl", [
      "--user",
      "disable",
      "--now",
      `${base}.timer`,
    ]).catch(() => undefined);
  }

  #systemdDirectory(): string {
    return join(
      this.#xdgConfigHome ?? join(this.#homeDir, ".config"),
      "systemd",
      "user",
    );
  }

  #markerPaths(): { upload: string; sync: string } {
    if (this.#platform === "linux") {
      const directory = this.#systemdDirectory();
      return {
        upload: join(directory, "brainhub-upload.timer"),
        sync: join(directory, "brainhub-sync.timer"),
      };
    }
    const directory = join(this.#homeDir, "Library", "LaunchAgents");
    return {
      upload: join(directory, "com.brainhub.upload.plist"),
      sync: join(directory, "com.brainhub.sync.plist"),
    };
  }
}
