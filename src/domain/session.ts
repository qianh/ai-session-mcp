import { createHash } from "node:crypto";

import { z } from "zod";

export const SessionSourceSchema = z.enum([
  "claude-code",
  "codex",
  "grok-build",
]);

export type SessionSource = z.infer<typeof SessionSourceSchema>;

export const ImageRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("embedded"),
    mediaType: z.string().min(1),
    data: z.string().min(1),
  }),
  z.object({
    kind: z.literal("remote"),
    url: z.url(),
  }),
]);

export type ImageRef = z.infer<typeof ImageRefSchema>;

export const TurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  images: z.array(ImageRefSchema),
});

export type Turn = z.infer<typeof TurnSchema>;

const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const NormalizedSessionSchema = z
  .object({
    source: SessionSourceSchema,
    conversationId: z.string().min(1),
    device: z.string().min(1),
    startedAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    turns: z.array(TurnSchema).min(1),
    sourcePath: z.string().min(1),
    warnings: z.array(z.string()),
  })
  .refine((session) => session.updatedAt >= session.startedAt, {
    message: "updatedAt must not precede startedAt",
    path: ["updatedAt"],
  });

export type NormalizedSession = z.infer<typeof NormalizedSessionSchema>;

export function conversationKey(
  source: SessionSource,
  conversationId: string,
): string {
  return createHash("sha256")
    .update(source)
    .update("\0")
    .update(conversationId)
    .digest("hex");
}
