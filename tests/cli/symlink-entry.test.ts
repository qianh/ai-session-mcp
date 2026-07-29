import { execFile } from "node:child_process";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "..", "..");

describe("CLI package entry", () => {
  it("runs when invoked through an npm-style symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brainhub-cli-entry-"));
    const entry = join(directory, "brainhub-mcp");
    await symlink(resolve(repository, "src", "cli", "index.ts"), entry);

    const { stdout } = await execute(
      process.execPath,
      ["--import", "tsx", entry, "--help"],
      { cwd: repository },
    );

    expect(stdout).toContain("Usage: brainhub-mcp");
  });

  it("reports the version from package metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brainhub-cli-version-"));
    const entry = join(directory, "brainhub-mcp");
    await symlink(resolve(repository, "src", "cli", "index.ts"), entry);
    const packageJson = JSON.parse(
      await readFile(resolve(repository, "package.json"), "utf8"),
    ) as { version: string };

    const { stdout } = await execute(
      process.execPath,
      ["--import", "tsx", entry, "--version"],
      { cwd: repository },
    );

    expect(stdout.trim()).toBe(packageJson.version);
  });
});
