import { execFile } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
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
});
