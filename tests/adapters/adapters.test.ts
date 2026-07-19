import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseClaudeSession } from "../../src/adapters/claude.js";
import { parseCodexSession } from "../../src/adapters/codex.js";
import { parseGrokSession } from "../../src/adapters/grok.js";

const fixture = (...parts: string[]) =>
  resolve(import.meta.dirname, "..", "fixtures", ...parts);

describe("source adapters", () => {
  it("parses visible Claude text and images while tolerating a trailing line", async () => {
    const result = await parseClaudeSession(
      fixture("claude", "top-level.jsonl"),
      {
        device: "test-device",
        includeSubagents: false,
      },
    );

    expect(result.malformedLines).toBe(1);
    expect(result.session?.conversationId).toBe("claude-1");
    expect(result.session?.turns).toEqual([
      { role: "user", text: "Review the deployment", images: [] },
      {
        role: "assistant",
        text: "Use a staged rollout.",
        images: [
          expect.objectContaining({ kind: "embedded", mediaType: "image/png" }),
        ],
      },
    ]);
  });

  it("skips Claude sidechains by default", async () => {
    const result = await parseClaudeSession(
      fixture("claude", "sidechain.jsonl"),
      {
        device: "test-device",
        includeSubagents: false,
      },
    );
    expect(result.skippedSubagent).toBe(true);
    expect(result.session).toBeNull();
  });

  it("parses Codex response items without duplicate events or tools", async () => {
    const result = await parseCodexSession(
      fixture("codex", "top-level.jsonl"),
      {
        device: "test-device",
        includeSubagents: false,
      },
    );
    expect(result.session?.conversationId).toBe("codex-1");
    expect(result.session?.turns.map((turn) => turn.text)).toEqual([
      "Find the release issue",
      "Pin the release version.",
    ]);
  });

  it("skips Codex subagent source objects", async () => {
    const result = await parseCodexSession(fixture("codex", "subagent.jsonl"), {
      device: "test-device",
      includeSubagents: false,
    });
    expect(result.skippedSubagent).toBe(true);
  });

  it("parses Grok chat history and skips tool/system records", async () => {
    const result = await parseGrokSession(fixture("grok", "top-level"), {
      device: "test-device",
      includeSubagents: false,
    });
    expect(result.session?.source).toBe("grok-build");
    expect(result.session?.turns.map((turn) => turn.text)).toEqual([
      "Compare the options",
      "Choose the simpler deployment.",
    ]);
  });

  it("skips Grok subagent sessions", async () => {
    const result = await parseGrokSession(fixture("grok", "subagent"), {
      device: "test-device",
      includeSubagents: false,
    });
    expect(result.skippedSubagent).toBe(true);
  });

  it('keeps Grok sessions whose session_kind is explicitly "main"', async () => {
    const directory = await mkdtemp(join(tmpdir(), "brainhub-grok-main-"));
    const source = fixture("grok", "top-level");
    await cp(source, directory, { recursive: true });
    const summaryPath = join(directory, "summary.json");
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Record<
      string,
      unknown
    >;
    summary.session_kind = "main";
    await writeFile(summaryPath, JSON.stringify(summary));

    const result = await parseGrokSession(directory, {
      device: "test-device",
      includeSubagents: false,
    });

    expect(result.skippedSubagent).toBe(false);
    expect(result.session?.source).toBe("grok-build");
  });
});
