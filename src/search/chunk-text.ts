import { createHash } from "node:crypto";

export interface TextChunk {
  id: string;
  start: number;
  end: number;
  tokenCount: number;
  text: string;
}

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
    chunks.push({
      id: createHash("sha256")
        .update(`${start}\0${end}\0${text.slice(start, end)}`)
        .digest("hex")
        .slice(0, 24),
      start,
      end,
      tokenCount: selected.length,
      text: text.slice(start, end),
    });
    if (tokenStart + options.maxTokens >= tokens.length) break;
  }
  return chunks;
}
