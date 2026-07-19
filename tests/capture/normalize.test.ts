import { describe, expect, it } from "vitest";

import {
  renderSessionMarkdown,
  sessionFilename,
} from "../../src/capture/normalize.js";
import type { NormalizedSession } from "../../src/domain/session.js";

const session: NormalizedSession = {
  source: "codex",
  conversationId: "019ac608-7fda-7061-9dac-5ebf03e4fc19",
  device: "macbook",
  startedAt: "2026-07-18T01:00:00.000Z",
  updatedAt: "2026-07-18T02:00:00.000Z",
  sourcePath: "/tmp/rollout.jsonl",
  warnings: [],
  turns: [
    { role: "user", text: "Question", images: [] },
    { role: "assistant", text: "Answer", images: [] },
  ],
};

describe("normalization", () => {
  it("renders the unified frontmatter and visible turns", () => {
    const rendered = renderSessionMarkdown(session, {
      redactionVersion: 1,
      redactionCount: 2,
      imageReferences: new Map(),
    });

    expect(rendered.markdown).toContain("source: codex");
    expect(rendered.markdown).toContain(
      "conversation_id: 019ac608-7fda-7061-9dac-5ebf03e4fc19",
    );
    expect(rendered.markdown).toContain("turn_count: 2");
    expect(rendered.markdown).toContain("redaction_count: 2");
    expect(rendered.markdown).toContain("## User\nQuestion");
    expect(rendered.markdown).toContain("## Assistant\nAnswer");
    expect(rendered.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses the manual filename contract", () => {
    expect(sessionFilename(session)).toBe("codex-20260718-019ac608.md");
  });
});
