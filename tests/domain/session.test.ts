import { describe, expect, it } from "vitest";

import {
  NormalizedSessionSchema,
  SessionSourceSchema,
  conversationKey,
} from "../../src/domain/session.js";

describe("session domain", () => {
  it("accepts only the three approved sources", () => {
    expect(SessionSourceSchema.options).toEqual([
      "claude-code",
      "codex",
      "grok-build",
    ]);
    expect(() => SessionSourceSchema.parse("gemini-cli")).toThrow();
  });

  it("builds a stable key without source/id ambiguity", () => {
    expect(conversationKey("codex", "abc")).toMatch(/^[a-f0-9]{64}$/);
    expect(conversationKey("codex", "abc")).toBe(
      conversationKey("codex", "abc"),
    );
    expect(conversationKey("codex", "abc")).not.toBe(
      conversationKey("claude-code", "abc"),
    );
  });

  it("rejects sessions with non-ISO timestamps or no visible turns", () => {
    const base = {
      source: "codex",
      conversationId: "abc",
      device: "macbook",
      startedAt: "2026-07-19T01:00:00.000Z",
      updatedAt: "2026-07-19T02:00:00.000Z",
      sourcePath: "/tmp/session.jsonl",
      turns: [{ role: "user", text: "hello", images: [] }],
      warnings: [],
    };

    expect(NormalizedSessionSchema.parse(base)).toMatchObject(base);
    expect(() =>
      NormalizedSessionSchema.parse({ ...base, startedAt: "yesterday" }),
    ).toThrow();
    expect(() =>
      NormalizedSessionSchema.parse({ ...base, turns: [] }),
    ).toThrow();
  });
});
