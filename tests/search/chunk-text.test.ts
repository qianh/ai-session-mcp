import { describe, expect, it } from "vitest";

import { chunkText } from "../../src/search/chunk-text.js";

describe("local search text chunks", () => {
  it("chunks mixed Chinese and English below the model limit with overlap", () => {
    const text = Array.from({ length: 620 }, (_, index) =>
      index % 2 === 0 ? `word${index}` : "中",
    ).join(" ");
    const chunks = chunkText(text, { maxTokens: 448, overlapTokens: 64 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.tokenCount <= 448)).toBe(true);
    expect(chunks[1]!.start).toBeLessThan(chunks[0]!.end);
  });
});
