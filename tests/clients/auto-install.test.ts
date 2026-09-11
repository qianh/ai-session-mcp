import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installLocalIntegrations } from "../../src/clients/auto-install.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "brainhub-auto-"));
  homes.push(homeDir);
  return {
    homeDir,
    launch: {
      command: process.execPath,
      args: ["/installed/brainhub/dist/cli/index.js"],
    },
  };
}
const missingRunner = async () => {
  throw new Error("not installed");
};

describe("automatic local installation", () => {
  it("registers Cursor and installs skills without running setup", async () => {
    const options = await fixture();
    await mkdir(join(options.homeDir, ".cursor"));
    const result = await installLocalIntegrations({
      ...options,
      run: missingRunner,
    });
    expect(result).toEqual({ installed: ["cursor"], warnings: [] });
    const config = JSON.parse(
      await readFile(join(options.homeDir, ".cursor/mcp.json"), "utf8"),
    );
    expect(config.mcpServers["brain-hub"]).toEqual({
      command: process.execPath,
      args: [...options.launch.args, "serve"],
    });
    expect(
      await readFile(
        join(options.homeDir, ".cursor/skills/brainhub-get-portrait/SKILL.md"),
        "utf8",
      ),
    ).toContain("name: brainhub-get-portrait");
  });
  it("backfills skills for registered clients without replacing their custom launch", async () => {
    const options = await fixture();
    const run = vi.fn<
      (
        client: string,
        args: string[],
      ) => Promise<{ exitCode: number; stdout: string }>
    >(async (client) => ({
      exitCode: client === "codex" ? 0 : 1,
      stdout:
        client === "codex" ? "brain-hub --config /custom/config.toml" : "",
    }));
    await installLocalIntegrations({ ...options, run });
    expect(
      await readFile(
        join(options.homeDir, ".codex/skills/brainhub-get-portrait/SKILL.md"),
        "utf8",
      ),
    ).toContain("brainhub-get-portrait");
    expect(run).toHaveBeenCalledWith("codex", ["mcp", "list"]);
    expect(run.mock.calls).not.toContainEqual([
      "codex",
      ["mcp", "add", "--help"],
    ]);
  });
  it("installs skills from directory detection when the GUI has no CLI and isolates broken clients", async () => {
    const options = await fixture();
    await mkdir(join(options.homeDir, ".claude"));
    await mkdir(join(options.homeDir, ".cursor"));
    await writeFile(join(options.homeDir, ".cursor/mcp.json"), "broken");
    const result = await installLocalIntegrations({
      ...options,
      run: missingRunner,
    });
    expect(result.installed).toContain("claude");
    expect(result.warnings.join(" ")).toContain("cursor");
    expect(
      await readFile(
        join(options.homeDir, ".claude/skills/brainhub-get-portrait/SKILL.md"),
        "utf8",
      ),
    ).toContain("brainhub-get-portrait");
    expect(
      await readFile(join(options.homeDir, ".cursor/mcp.json"), "utf8"),
    ).toBe("broken");
  });
  it("repairs skills at server startup without spawning clients or registering MCP recursively", async () => {
    const options = await fixture();
    await mkdir(join(options.homeDir, ".codex"));
    const run = vi.fn(missingRunner);
    await installLocalIntegrations({ ...options, run, skillsOnly: true });
    expect(run).not.toHaveBeenCalled();
    expect(
      await readFile(
        join(options.homeDir, ".codex/skills/brainhub-hub-status/SKILL.md"),
        "utf8",
      ),
    ).toContain("brainhub-hub-status");
    await expect(
      readFile(join(options.homeDir, ".cursor/mcp.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("leaves a machine with no clients untouched", async () => {
    const options = await fixture();
    expect(
      await installLocalIntegrations({ ...options, run: missingRunner }),
    ).toEqual({ installed: [], warnings: [] });
    await expect(
      readFile(join(options.homeDir, ".cursor/mcp.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
