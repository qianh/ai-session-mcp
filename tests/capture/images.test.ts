import { describe, expect, it } from "vitest";

import { processSessionImages } from "../../src/capture/images.js";
import type { NormalizedSession } from "../../src/domain/session.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("image processing", () => {
  it("deduplicates base64 images by original SHA-256 and converts to WebP", async () => {
    const session: NormalizedSession = {
      source: "claude-code",
      conversationId: "images",
      device: "test",
      startedAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:01:00.000Z",
      sourcePath: "/tmp/images.jsonl",
      warnings: [],
      turns: [
        {
          role: "user",
          text: "one",
          images: [{ kind: "embedded", mediaType: "image/png", data: png }],
        },
        {
          role: "assistant",
          text: "two",
          images: [{ kind: "embedded", mediaType: "image/png", data: png }],
        },
      ],
    };

    const result = await processSessionImages(session);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.artifacts[0]?.drivePath).toMatch(
      /^images\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.webp$/,
    );
    expect(result.artifacts[0]?.bytes.subarray(0, 4).toString("ascii")).toBe(
      "RIFF",
    );
    expect(result.references.size).toBe(1);
  });
});
