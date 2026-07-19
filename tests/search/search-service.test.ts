import { describe, expect, it } from "vitest";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { Embedder } from "../../src/search/embedder.js";
import { SearchService } from "../../src/search/search-service.js";

class SemanticEmbedder implements Embedder {
  readonly model = "semantic-test";
  readonly revision = "v1";
  readonly dimensions = 3;

  async embedQuery(text: string): Promise<number[]> {
    return this.#vector(text.replace(/^query:\s*/u, ""));
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.#vector(text.replace(/^passage:\s*/u, "")));
  }

  #vector(text: string): number[] {
    const lower = text.toLowerCase();
    const raw = [
      /deploy|release|发布/u.test(lower) ? 1 : 0,
      /database|sqlite|数据库/u.test(lower) ? 1 : 0,
      /portrait|画像/u.test(lower) ? 1 : 0,
    ];
    const norm = Math.hypot(...raw) || 1;
    return raw.map((value) => value / norm);
  }
}

function markdown(fields: {
  source: string;
  conversationId: string;
  contentSha: string;
  text: string;
}): Buffer {
  return Buffer.from(`---
source: ${fields.source}
conversation_id: ${fields.conversationId}
started_at: 2026-07-18T01:00:00.000Z
updated_at: 2026-07-18T02:00:00.000Z
content_sha256: ${fields.contentSha}
---
## User
${fields.text}
`);
}

describe("hybrid search", () => {
  it("indexes Drive content, finds semantic matches, and deduplicates conversations", async () => {
    const drive = new MemoryDrive();
    const contentSha = "a".repeat(64);
    await drive.put({
      path: "inbox/mac/codex.md",
      bytes: markdown({
        source: "codex",
        conversationId: "conversation-1",
        contentSha,
        text: "Use a canary rollout for production.",
      }),
      mimeType: "text/markdown",
    });
    await drive.put({
      path: "sessions/2026-07/codex.md",
      bytes: markdown({
        source: "codex",
        conversationId: "conversation-1",
        contentSha,
        text: "Use a canary rollout for production.",
      }),
      mimeType: "text/markdown",
    });
    const search = new SearchService({
      drive,
      embedder: new SemanticEmbedder(),
    });

    const result = await search.search({
      query: "release strategy",
      limit: 10,
    });

    expect(result.indexStatus).toBe("fresh");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      kind: "session",
      conversationId: "conversation-1",
      source: "codex",
    });
    expect(
      await drive.readPath("_meta/search/v1/manifest.json"),
    ).not.toBeNull();
    expect(
      (await drive.list({ prefix: "_meta/search/v1/objects/" })).map(
        (entry) => entry.path,
      ),
    ).toHaveLength(2);
  });

  it("reports a stale index when refresh fails but an old manifest is usable", async () => {
    const drive = new MemoryDrive();
    const search = new SearchService({
      drive,
      embedder: new SemanticEmbedder(),
    });
    await search.sync();
    const brokenDrive = new Proxy(drive, {
      get(target, property, receiver) {
        if (property === "list")
          return async () => Promise.reject(new Error("offline"));
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const stale = new SearchService({
      drive: brokenDrive as never,
      embedder: new SemanticEmbedder(),
    });
    const result = await stale.search({ query: "release", limit: 10 });
    expect(result.indexStatus).toBe("stale");
    expect(result.warnings[0]?.code).toBe("INDEX_STALE");
  });

  it("rebuilds a corrupt vector object during sync", async () => {
    const drive = new MemoryDrive();
    const contentSha = "c".repeat(64);
    await drive.put({
      path: "sessions/2026-07/session.md",
      bytes: markdown({
        source: "codex",
        conversationId: "repair-me",
        contentSha,
        text: "database migration",
      }),
      mimeType: "text/markdown",
    });
    const vectorPath = `_meta/search/v1/objects/session/2026-07/${contentSha}.vec`;
    await drive.put({
      path: vectorPath,
      bytes: Buffer.from("corrupt"),
      mimeType: "application/vnd.brainhub.vector+json",
    });
    const service = new SearchService({
      drive,
      embedder: new SemanticEmbedder(),
    });

    await service.sync();
    const repaired = await drive.readPath(vectorPath);
    expect(repaired?.bytes.toString()).not.toBe("corrupt");
    await expect(
      service.search({ query: "sqlite", limit: 10 }),
    ).resolves.toMatchObject({ indexStatus: "fresh" });
  });
});
