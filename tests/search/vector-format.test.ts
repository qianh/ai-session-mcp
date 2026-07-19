import { describe, expect, it } from "vitest";

import {
  chunkText,
  decodeVectorObject,
  encodeVectorObject,
  vectorObjectPath,
} from "../../src/search/vector-format.js";

describe("vector object format", () => {
  it("chunks mixed Chinese and English below the model limit with overlap", () => {
    const text = Array.from({ length: 620 }, (_, index) =>
      index % 2 === 0 ? `word${index}` : "中",
    ).join(" ");
    const chunks = chunkText(text, { maxTokens: 448, overlapTokens: 64 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.tokenCount <= 448)).toBe(true);
    expect(chunks[1]!.start).toBeLessThan(chunks[0]!.end);
  });

  it("round-trips checksummed vectors and rejects corruption", () => {
    const object = {
      schemaVersion: 1 as const,
      model: "test-model",
      revision: "v1",
      dimensions: 3,
      contentSha256: "a".repeat(64),
      chunks: [{ id: "chunk-1", start: 0, end: 5, vector: [1, 0, 0] }],
    };
    const encoded = encodeVectorObject(object);
    expect(decodeVectorObject(encoded)).toEqual(object);
    const corrupt = Buffer.from(encoded);
    corrupt[corrupt.length - 2] = corrupt[corrupt.length - 2]! ^ 1;
    expect(() => decodeVectorObject(corrupt)).toThrow(/checksum|decode/i);
    expect(vectorObjectPath("session", "2026-07", object.contentSha256)).toBe(
      `_meta/search/v1/objects/session/2026-07/${object.contentSha256}.vec`,
    );
  });
});
