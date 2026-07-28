import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { Embedder } from "../../src/search/embedder.js";
import { SearchService } from "../../src/search/search-service.js";

class SemanticEmbedder implements Embedder {
  readonly model = "semantic-test";
  readonly revision = "v1";
  readonly dimensions = 3;

  async embedQuery(text: string): Promise<number[]> {
    return this.#vector(text);
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.#vector(text));
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

class UnavailableEmbedder implements Embedder {
  readonly model = "unavailable-test";
  readonly revision = "v1";
  readonly dimensions = 3;

  async embedQuery(): Promise<number[]> {
    throw new Error("model unavailable");
  }

  async embedPassages(): Promise<number[][]> {
    throw new Error("model unavailable");
  }
}

class RecoveringEmbedder implements Embedder {
  readonly model = "recovering-test";
  readonly revision = "v1";
  readonly dimensions = 3;
  available = false;

  async embedQuery(): Promise<number[]> {
    if (!this.available) throw new Error("model unavailable");
    return [1, 0, 0];
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    if (!this.available) throw new Error("model unavailable");
    return texts.map(() => [1, 0, 0]);
  }
}

class ConfigurableEmbedder implements Embedder {
  readonly model = "structural-test";
  readonly revision = "v1";

  constructor(readonly dimensions: number) {}

  async embedQuery(): Promise<number[]> {
    return [1, ...Array.from({ length: this.dimensions - 1 }, () => 0)];
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    return texts.map(() => [
      1,
      ...Array.from({ length: this.dimensions - 1 }, () => 0),
    ]);
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

async function indexPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "brainhub-search-"));
  return join(directory, "index.sqlite");
}

describe("local hybrid search", () => {
  it("indexes only inbox content in local SQLite without writing to Drive", async () => {
    const drive = new MemoryDrive();
    const driveWrite = vi.spyOn(drive, "upsert");
    await drive.put({
      path: "inbox/mac/codex.md",
      bytes: markdown({
        source: "codex",
        conversationId: "conversation-1",
        contentSha: "a".repeat(64),
        text: "Use a canary rollout for production.",
      }),
      mimeType: "text/markdown",
    });
    await drive.put({
      path: "sessions/2026-07/legacy.md",
      bytes: markdown({
        source: "codex",
        conversationId: "legacy-session",
        contentSha: "b".repeat(64),
        text: "Release the legacy session.",
      }),
      mimeType: "text/markdown",
    });
    const service = new SearchService({
      drive,
      embedder: new SemanticEmbedder(),
      indexPath: await indexPath(),
    });

    const result = await service.search({
      query: "release strategy",
      limit: 10,
    });

    expect(result).toMatchObject({
      indexStatus: "fresh",
      searchMode: "semantic",
      results: [
        {
          source: "codex",
          conversationId: "conversation-1",
        },
      ],
    });
    expect(result.results[0]).not.toHaveProperty("driveFileId");
    expect(result.results[0]).not.toHaveProperty("kind");
    expect(driveWrite).not.toHaveBeenCalled();
    expect(await drive.list({ prefix: "_meta/search/" })).toEqual([]);
  });

  it("uses the last local index and warns when Drive refresh fails", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/codex.md",
      bytes: markdown({
        source: "codex",
        conversationId: "conversation-1",
        contentSha: "c".repeat(64),
        text: "Database migration with SQLite.",
      }),
      mimeType: "text/markdown",
    });
    const path = await indexPath();
    await new SearchService({
      drive,
      embedder: new SemanticEmbedder(),
      indexPath: path,
    }).sync();
    const brokenDrive = new Proxy(drive, {
      get(target, property, receiver) {
        if (property === "changes") {
          return async () => Promise.reject(new Error("offline"));
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = await new SearchService({
      drive: brokenDrive as never,
      embedder: new SemanticEmbedder(),
      indexPath: path,
    }).search({ query: "sqlite", limit: 10 });

    expect(result.indexStatus).toBe("stale");
    expect(result.results[0]?.conversationId).toBe("conversation-1");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "INDEX_STALE" }),
    );
  });

  it("persists and resumes the Drive change cursor", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/codex.md",
      bytes: markdown({
        source: "codex",
        conversationId: "incremental-session",
        contentSha: "e".repeat(64),
        text: "First revision.",
      }),
      mimeType: "text/markdown",
    });
    const read = vi.spyOn(drive, "read");
    const service = new SearchService({
      drive,
      embedder: new SemanticEmbedder(),
      indexPath: await indexPath(),
    });

    await service.sync();
    await service.sync();
    expect(read).toHaveBeenCalledTimes(1);

    await drive.upsert({
      path: "inbox/mac/codex.md",
      bytes: markdown({
        source: "codex",
        conversationId: "incremental-session",
        contentSha: "f".repeat(64),
        text: "Second revision.",
      }),
      mimeType: "text/markdown",
    });
    await service.sync();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("falls back explicitly to keyword search when the model is unavailable", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/codex.md",
      bytes: markdown({
        source: "codex",
        conversationId: "keyword-session",
        contentSha: "d".repeat(64),
        text: "The launch checklist contains a rollback step.",
      }),
      mimeType: "text/markdown",
    });
    const service = new SearchService({
      drive,
      embedder: new UnavailableEmbedder(),
      indexPath: await indexPath(),
    });

    const result = await service.search({ query: "rollback", limit: 10 });

    expect(result.searchMode).toBe("keyword");
    expect(result.results[0]?.conversationId).toBe("keyword-session");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "MODEL_UNAVAILABLE_KEYWORD_FALLBACK" }),
    );
  });

  it("rebuilds missing vectors after a temporarily unavailable model recovers", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/recover.md",
      bytes: markdown({
        source: "codex",
        conversationId: "recovery-session",
        contentSha: "1".repeat(64),
        text: "Release recovery procedure.",
      }),
      mimeType: "text/markdown",
    });
    const embedder = new RecoveringEmbedder();
    const service = new SearchService({
      drive,
      embedder,
      indexPath: await indexPath(),
    });

    const degraded = await service.search({ query: "release", limit: 10 });
    embedder.available = true;
    const recovered = await service.search({ query: "release", limit: 10 });

    expect(degraded.searchMode).toBe("keyword");
    expect(recovered).toMatchObject({
      indexStatus: "fresh",
      searchMode: "semantic",
      results: [{ conversationId: "recovery-session" }],
    });
  });

  it.each([
    {
      label: "embedding dimensions",
      first: { dimensions: 3, chunkTokens: 448, chunkOverlap: 64 },
      second: { dimensions: 4, chunkTokens: 448, chunkOverlap: 64 },
    },
    {
      label: "chunk size",
      first: { dimensions: 3, chunkTokens: 448, chunkOverlap: 64 },
      second: { dimensions: 3, chunkTokens: 320, chunkOverlap: 64 },
    },
    {
      label: "chunk overlap",
      first: { dimensions: 3, chunkTokens: 448, chunkOverlap: 64 },
      second: { dimensions: 3, chunkTokens: 448, chunkOverlap: 32 },
    },
  ])("rebuilds the index when $label changes", async ({ first, second }) => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/structural.md",
      bytes: markdown({
        source: "codex",
        conversationId: "structural-session",
        contentSha: "2".repeat(64),
        text: "Database release notes.",
      }),
      mimeType: "text/markdown",
    });
    const path = await indexPath();
    await new SearchService({
      drive,
      embedder: new ConfigurableEmbedder(first.dimensions),
      indexPath: path,
      chunkTokens: first.chunkTokens,
      chunkOverlap: first.chunkOverlap,
    }).sync();
    const read = vi.spyOn(drive, "read");

    await new SearchService({
      drive,
      embedder: new ConfigurableEmbedder(second.dimensions),
      indexPath: path,
      chunkTokens: second.chunkTokens,
      chunkOverlap: second.chunkOverlap,
    }).sync();

    expect(read).toHaveBeenCalledTimes(1);
  });
});
