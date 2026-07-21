import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "..", "..");
const supportedPlatform = ["darwin", "linux"].includes(process.platform);

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function installFixture(at: string) {
  const home = await mkdtemp(join(tmpdir(), "brainhub-client-install-"));
  const bin = join(home, "bin");
  const clientLog = join(home, "client.log");
  const schedulerLog = join(home, "scheduler.log");
  const config = join(home, "config.toml");
  await mkdir(bin, { recursive: true });
  await writeFile(
    config,
    `version = 1
[device]
name = "install-test"
[scheduler]
at = ${JSON.stringify(at)}
`,
  );
  await writeExecutable(
    join(bin, "codex"),
    `#!/bin/sh
if [ "$1" = "mcp" ] && [ "$2" = "add" ] && [ "$3" = "--help" ]; then
  printf '%s\\n' --
  exit 0
fi
printf '%s\\n' "$*" >> ${JSON.stringify(clientLog)}
`,
  );
  const schedulerCommand =
    process.platform === "darwin" ? "launchctl" : "systemctl";
  await writeExecutable(
    join(bin, schedulerCommand),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(schedulerLog)}
`,
  );
  const schedulerFile =
    process.platform === "darwin"
      ? join(home, "Library", "LaunchAgents", "com.brainhub.upload.plist")
      : join(home, ".config", "systemd", "user", "brainhub-upload.timer");
  const scheduledCommandFile =
    process.platform === "darwin"
      ? schedulerFile
      : join(home, ".config", "systemd", "user", "brainhub-upload.service");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
  delete env.BRAINHUB_CONFIG;
  return {
    home,
    config,
    clientLog,
    schedulerLog,
    schedulerFile,
    scheduledCommandFile,
    env,
  };
}

describe.skipIf(!supportedPlatform)("MCP client installation", () => {
  it("installs the configured daily upload by default", async () => {
    const fixture = await installFixture("03:17");

    const { stdout } = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "--config",
        fixture.config,
        "clients",
        "install",
        "codex",
        "--json",
      ],
      { cwd: repository, env: fixture.env },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      action: "install",
      clients: ["codex"],
      scheduler: { installed: true, at: "03:17" },
    });
    await expect(access(fixture.schedulerFile)).resolves.toBeUndefined();
    await expect(readFile(fixture.clientLog, "utf8")).resolves.toContain(
      "mcp add brain-hub",
    );
    await expect(readFile(fixture.schedulerLog, "utf8")).resolves.toMatch(
      /bootstrap|enable/u,
    );
    const scheduledCommand = await readFile(
      fixture.scheduledCommandFile,
      "utf8",
    );
    const expectedConfigArgs =
      process.platform === "darwin"
        ? `<string>--config</string>\n    <string>${fixture.config}</string>\n    <string>upload</string>`
        : `--config ${fixture.config} upload --json`;
    expect(scheduledCommand).toContain(expectedConfigArgs);
  }, 15_000);

  it("supports explicitly installing a client without daily uploads", async () => {
    const fixture = await installFixture("03:17");

    const { stdout } = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "--config",
        fixture.config,
        "clients",
        "install",
        "codex",
        "--no-scheduler",
        "--json",
      ],
      { cwd: repository, env: fixture.env },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      action: "install",
      clients: ["codex"],
      scheduler: { installed: false },
    });
    await expect(access(fixture.schedulerFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(fixture.schedulerLog)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(fixture.clientLog, "utf8")).resolves.toContain(
      "mcp add brain-hub",
    );
  }, 15_000);
});
