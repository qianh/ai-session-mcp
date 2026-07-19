import { createHash } from "node:crypto";

import sharp from "sharp";

import type { NormalizedSession } from "../domain/session.js";

export interface ImageArtifact {
  sha256: string;
  drivePath: string;
  bytes: Buffer;
}

export function embeddedImageKey(data: string): string {
  return createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
}

export async function processSessionImages(
  session: NormalizedSession,
): Promise<{
  artifacts: ImageArtifact[];
  references: Map<string, string>;
}> {
  const artifacts: ImageArtifact[] = [];
  const references = new Map<string, string>();
  for (const turn of session.turns) {
    for (const image of turn.images) {
      if (image.kind !== "embedded") continue;
      const sha256 = embeddedImageKey(image.data);
      if (references.has(sha256)) continue;
      const drivePath = `images/sha256/${sha256.slice(0, 2)}/${sha256}.webp`;
      const bytes = await sharp(Buffer.from(image.data, "base64"))
        .rotate()
        .webp({ quality: 80 })
        .toBuffer();
      references.set(sha256, drivePath);
      artifacts.push({ sha256, drivePath, bytes });
    }
  }
  return { artifacts, references };
}
