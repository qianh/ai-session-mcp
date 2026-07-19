import { cp, mkdtemp, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverSessions } from "../../src/adapters/index.js";

const fixtures = resolve(import.meta.dirname, "..", "fixtures");

describe("session discovery", () => {
  it("discovers all configured sources and aggregates skips/malformed lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "brainhub-discovery-"));
    const claude = join(root, "claude", "project", "session.jsonl");
    const codex = join(root, "codex", "2026", "07", "18", "rollout-test.jsonl");
    const grok = join(root, "grok", "workspace", "top-level");
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
    const grokShell = join(root, "grok", "workspace", "summary-only");
    await mkdir(grokShell, { recursive: true });
    await cp(
      join(fixtures, "grok", "top-level", "summary.json"),
      join(grokShell, "summary.json"),
    );

    const result = await discoverSessions({
      device: "test",
      includeSubagents: false,
      sources: ["claude-code", "codex", "grok-build"],
      paths: {
        claude: [join(root, "claude")],
        codex: [join(root, "codex")],
        grok: [join(root, "grok")],
      },
    });

    expect(result.sessions.map((session) => session.source).sort()).toEqual([
      "claude-code",
      "codex",
      "grok-build",
    ]);
    expect(result.malformed).toBe(1);
    expect(result.status.codex.discovered).toBe(1);
    expect(result.status.grok.discovered).toBe(1);
    expect(result.status.grok.errors).toBe(0);
  });

  it("parses only files newer than the incremental watermark", async () => {
    const root = await mkdtemp(join(tmpdir(), "brainhub-incremental-"));
    const oldPath = join(root, "2026", "07", "17", "rollout-old.jsonl");
    const newPath = join(root, "2026", "07", "19", "rollout-new.jsonl");
    await Promise.all([
      mkdir(dirname(oldPath), { recursive: true }),
      mkdir(dirname(newPath), { recursive: true }),
    ]);
    await Promise.all([
      cp(join(fixtures, "codex", "top-level.jsonl"), oldPath),
      cp(join(fixtures, "codex", "top-level.jsonl"), newPath),
    ]);
    await Promise.all([
      utimes(
        oldPath,
        new Date("2026-07-17T00:00:00.000Z"),
        new Date("2026-07-17T00:00:00.000Z"),
      ),
      utimes(
        newPath,
        new Date("2026-07-19T00:00:00.000Z"),
        new Date("2026-07-19T00:00:00.000Z"),
      ),
    ]);

    const result = await discoverSessions({
      device: "test",
      includeSubagents: false,
      sources: ["codex"],
      paths: { claude: [], codex: [root], grok: [] },
      modifiedAfter: { codex: "2026-07-18T00:00:00.000Z" },
      includePaths: [],
    });

    expect(result.status.codex.discovered).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });
});
