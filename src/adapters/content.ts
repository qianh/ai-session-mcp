import type { ImageRef, Turn } from "../domain/session.js";
import { asRecord, asString } from "./jsonl.js";

const visibleTextTypes = new Set(["text", "input_text", "output_text"]);

function parseImage(part: Record<string, unknown>): ImageRef | null {
  const source = asRecord(part.source);
  if (source?.type === "base64") {
    const data = asString(source.data);
    const mediaType = asString(source.media_type) ?? asString(source.mediaType);
    return data && mediaType ? { kind: "embedded", mediaType, data } : null;
  }

  const url =
    asString(part.image_url) ??
    asString(part.url) ??
    (asRecord(part.image_url) ? asString(asRecord(part.image_url)?.url) : null);
  if (!url) return null;
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.+)$/u.exec(url);
    return match?.[1] && match[2]
      ? { kind: "embedded", mediaType: match[1], data: match[2] }
      : null;
  }
  try {
    new URL(url);
    return { kind: "remote", url };
  } catch {
    return null;
  }
}

export function visibleTurnContent(
  role: "user" | "assistant",
  content: unknown,
): Turn | null {
  if (typeof content === "string") {
    return content.length > 0 ? { role, text: content, images: [] } : null;
  }
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  const images: ImageRef[] = [];
  for (const value of content) {
    const part = asRecord(value);
    if (!part) continue;
    const type = asString(part.type);
    if (type && visibleTextTypes.has(type)) {
      const text = asString(part.text);
      if (text) texts.push(text);
      continue;
    }
    if (type === "image" || type === "input_image" || part.image_url) {
      const image = parseImage(part);
      if (image) images.push(image);
    }
  }

  const text = texts.join("\n");
  return text || images.length > 0 ? { role, text, images } : null;
}

export function timestampBounds(
  values: Array<string | null>,
  fallback: string,
): { startedAt: string; updatedAt: string } {
  const valid = values
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.valueOf()))
    .sort((left, right) => left.valueOf() - right.valueOf());
  return {
    startedAt: (valid.at(0) ?? new Date(fallback)).toISOString(),
    updatedAt: (valid.at(-1) ?? new Date(fallback)).toISOString(),
  };
}
