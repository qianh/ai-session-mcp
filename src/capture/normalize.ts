import { createHash } from "node:crypto";

import type { ImageRef, NormalizedSession } from "../domain/session.js";
import { embeddedImageKey } from "./images.js";

export interface RenderOptions {
  redactionVersion: number;
  redactionCount: number;
  imageReferences: Map<string, string>;
}

function renderImage(
  image: ImageRef,
  references: Map<string, string>,
): string | null {
  if (image.kind === "remote") return `![](${image.url})`;
  const path = references.get(embeddedImageKey(image.data));
  return path ? `![](${path})` : null;
}

export function sessionFilename(session: NormalizedSession): string {
  const date = session.startedAt.slice(0, 10).replaceAll("-", "");
  const shortId = session.conversationId
    .replace(/[^A-Za-z0-9]/gu, "")
    .slice(0, 8);
  return `${session.source}-${date}-${shortId}.md`;
}

export function renderSessionMarkdown(
  session: NormalizedSession,
  options: RenderOptions,
): { markdown: string; contentSha256: string } {
  const body = session.turns
    .map((turn) => {
      const images = turn.images
        .map((image) => renderImage(image, options.imageReferences))
        .filter((value): value is string => Boolean(value));
      const content = [turn.text, ...images].filter(Boolean).join("\n\n");
      return `## ${turn.role === "user" ? "User" : "Assistant"}\n${content}`;
    })
    .join("\n\n");
  const canonical = [
    `source: ${session.source}`,
    `conversation_id: ${session.conversationId}`,
    `device: ${session.device}`,
    `started_at: ${session.startedAt}`,
    `updated_at: ${session.updatedAt}`,
    `turn_count: ${session.turns.length}`,
    `redaction_version: ${options.redactionVersion}`,
    `redaction_count: ${options.redactionCount}`,
    "---",
    body,
    "",
  ].join("\n");
  const contentSha256 = createHash("sha256").update(canonical).digest("hex");
  const markdown = `---\n${canonical.replace("---\n", `content_sha256: ${contentSha256}\n---\n`)}`;
  return { markdown, contentSha256 };
}
