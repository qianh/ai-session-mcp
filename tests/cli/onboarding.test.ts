import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/index.js";
import { SetupService } from "../../src/setup/setup-service.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CLI onboarding", () => {
  it.each(["--help", "--version"])(
    "does not start setup for %s",
    async (flag) => {
      const setup = vi.spyOn(SetupService.prototype, "run");
      const stop = new Error("CLI informational exit");
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw stop;
      });
      vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await expect(runCli(["node", "brainhub-mcp", flag])).rejects.toBe(stop);

      expect(exit).toHaveBeenCalledWith(0);
      expect(setup).not.toHaveBeenCalled();
    },
  );

  it.each([{ args: [] }, { args: ["setup"] }])(
    "starts setup with a custom config for $args",
    async ({ args }) => {
      const directory = await mkdtemp(
        join(tmpdir(), "brainhub-cli-onboarding-"),
      );
      directories.push(directory);
      const configFile = join(directory, "custom.toml");
      const stop = new Error("setup reached");
      const persist = vi.fn().mockResolvedValue(undefined);
      const setup = vi
        .spyOn(SetupService.prototype, "run")
        .mockImplementation(async function (this: SetupService) {
          await this.dependencies.ensureConfig();
          throw stop;
        });
      vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("CLI exited");
      });
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(
        runCli(["node", "brainhub-mcp", "--config", configFile, ...args], {
          writeConfig: persist,
          writeOutput: () => undefined,
        }),
      ).rejects.toBe(stop);

      expect(setup).toHaveBeenCalledOnce();
      expect(persist).toHaveBeenCalledWith(configFile, expect.any(Object));
    },
  );

  it("keeps explicit config commands out of interactive setup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brainhub-cli-onboarding-"));
    directories.push(directory);
    const configFile = join(directory, "custom.toml");
    const setup = vi.spyOn(SetupService.prototype, "run");
    const output: string[] = [];

    await runCli(
      [
        "node",
        "brainhub-mcp",
        "--config",
        configFile,
        "config",
        "show",
        "--json",
      ],
      {
        writeOutput: (value) => output.push(value),
      },
    );

    expect(setup).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!).file).toBe(configFile);
  });
});
