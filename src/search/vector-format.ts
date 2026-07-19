import { createHash } from "node:crypto";

import { z } from "zod";

export interface TextChunk {
  id: string;
  start: number;
  end: number;
  tokenCount: number;
  text: string;
}

export interface VectorChunk {
  id: string;
  start: number;
  end: number;
  vector: number[];
}

export interface VectorObject {
  schemaVersion: 1;
  model: string;
  revision: string;
  dimensions: number;
  contentSha256: string;
  chunks: VectorChunk[];
}

const VectorObjectSchema = z.object({
  schemaVersion: z.literal(1),
  model: z.string().min(1),
  revision: z.string().min(1),
  dimensions: z.number().int().positive(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  chunks: z.array(
    z.object({
      id: z.string().min(1),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      vector: z.array(z.number()),
    }),
  ),
});

const tokenPattern = /[\p{Script=Han}]|[\p{L}\p{N}_]+|[^\s]/gu;

export function chunkText(
  text: string,
  options: { maxTokens: number; overlapTokens: number },
): TextChunk[] {
  if (
    options.maxTokens <= 0 ||
    options.overlapTokens < 0 ||
    options.overlapTokens >= options.maxTokens
  ) {
    throw new Error("Invalid chunk configuration");
  }
  const tokens = [...text.matchAll(tokenPattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  if (tokens.length === 0) return [];
  const chunks: TextChunk[] = [];
  const step = options.maxTokens - options.overlapTokens;
  for (let tokenStart = 0; tokenStart < tokens.length; tokenStart += step) {
    const selected = tokens.slice(tokenStart, tokenStart + options.maxTokens);
    const first = selected[0];
    const last = selected.at(-1);
    if (!first || !last) break;
    const start = first.start;
    const end = last.end;
    const id = createHash("sha256")
      .update(`${start}\0${end}\0${text.slice(start, end)}`)
      .digest("hex")
      .slice(0, 24);
    chunks.push({
      id,
      start,
      end,
      tokenCount: selected.length,
      text: text.slice(start, end),
    });
    if (tokenStart + options.maxTokens >= tokens.length) break;
  }
  return chunks;
}

export function encodeVectorObject(object: VectorObject): Buffer {
  const parsed = VectorObjectSchema.parse(object);
  for (const chunk of parsed.chunks) {
    if (chunk.vector.length !== parsed.dimensions)
      throw new Error("Vector dimensions do not match object header");
  }
  const payload = JSON.stringify(parsed);
  const checksum = createHash("sha256").update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ checksum, payload }));
}

export function decodeVectorObject(bytes: Buffer): VectorObject {
  try {
    const envelope = JSON.parse(bytes.toString("utf8")) as {
      checksum?: unknown;
      payload?: unknown;
    };
    if (
      typeof envelope.checksum !== "string" ||
      typeof envelope.payload !== "string"
    ) {
      throw new Error("Invalid vector envelope");
    }
    const actual = createHash("sha256").update(envelope.payload).digest("hex");
    if (actual !== envelope.checksum)
      throw new Error("Vector checksum mismatch");
    const parsed = VectorObjectSchema.parse(
      JSON.parse(envelope.payload) as unknown,
    );
    for (const chunk of parsed.chunks) {
      if (chunk.vector.length !== parsed.dimensions)
        throw new Error("Vector dimensions mismatch");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Unable to decode vector object: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }
}

export function vectorObjectPath(
  kind: "card" | "session" | "inbox",
  month: string,
  contentSha256: string,
): string {
  if (!/^\d{4}-\d{2}$/u.test(month) || !/^[a-f0-9]{64}$/u.test(contentSha256)) {
    throw new Error("Invalid vector object identity");
  }
  return `_meta/search/v1/objects/${kind}/${month}/${contentSha256}.vec`;
}
