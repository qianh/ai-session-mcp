import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "..", "..");
const fixtures = join(repository, "tests", "fixtures");

describe("CLI dry run", () => {
  it("scans every adapter without Drive, OAuth, or persistent state", async () => {
    const home = await mkdtemp(join(tmpdir(), "brainhub-e2e-"));
    const claude = join(
      home,
      "histories",
      "claude",
      "project",
      "session.jsonl",
    );
    const codex = join(
      home,
      "histories",
      "codex",
      "2026",
      "07",
      "18",
      "rollout-test.jsonl",
    );
    const grok = join(home, "histories", "grok", "project", "session");
    await Promise.all([
      mkdir(dirname(claude), { recursive: true }),
      mkdir(dirname(codex), { recursive: true }),
      mkdir(grok, { recursive: true }),
    ]);
    await cp(join(fixtures, "claude", "top-level.jsonl"), claude);
    await cp(join(fixtures, "codex", "top-level.jsonl"), codex);
    await cp(
      join(fixtures, "grok", "top-level", "summary.json"),
      join(grok, "summary.json"),
    );
    await cp(
      join(fixtures, "grok", "top-level", "chat_history.jsonl"),
      join(grok, "chat_history.jsonl"),
    );
    const config = join(home, "config.toml");
    await writeFile(
      config,
      `version = 1
[device]
name = "e2e"
[capture]
claude_paths = [${JSON.stringify(dirname(dirname(claude)))}]
codex_paths = [${JSON.stringify(join(home, "histories", "codex"))}]
grok_paths = [${JSON.stringify(join(home, "histories", "grok"))}]
`,
    );

    const { stdout } = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "upload",
        "--backfill",
        "--dry-run",
        "--json",
      ],
      {
        cwd: repository,
        env: { ...process.env, HOME: home, BRAINHUB_CONFIG: config },
      },
    );
    const result = JSON.parse(stdout) as Record<string, unknown>;
    expect(result).toMatchObject({
      dryRun: true,
      scanned: 3,
      eligible: 3,
      uploaded: 0,
      malformed: 1,
    });
    const statePath =
      process.platform === "darwin"
        ? join(
            home,
            "Library",
            "Application Support",
            "BrainHub",
            "state.sqlite",
          )
        : join(home, ".local", "state", "brain-mcp", "state.sqlite");
    await expect(
      import("node:fs/promises").then(({ access }) => access(statePath)),
    ).rejects.toThrow();
  }, 15_000);
});
