import { stat } from "node:fs/promises";

import { NormalizedSessionSchema, type Turn } from "../domain/session.js";
import { visibleTurnContent, timestampBounds } from "./content.js";
import { asRecord, asString, readJsonLines } from "./jsonl.js";
import type { AdapterOptions, AdapterResult } from "./types.js";

export async function parseClaudeSession(
  path: string,
  options: AdapterOptions,
): Promise<AdapterResult> {
  const [{ records, malformedLines }, fileStat] = await Promise.all([
    readJsonLines(path),
    stat(path),
  ]);
  const objects = records.map(asRecord).filter((value) => value !== null);
  const isSidechain = objects.some((record) => record.isSidechain === true);
  if (isSidechain && !options.includeSubagents) {
    return { session: null, skippedSubagent: true, malformedLines };
  }

  const turns: Turn[] = [];
  const timestamps: Array<string | null> = [];
  let conversationId: string | null = null;
  for (const record of objects) {
    conversationId ??= asString(record.sessionId);
    timestamps.push(asString(record.timestamp));
    if (record.type !== "user" && record.type !== "assistant") continue;
    const message = asRecord(record.message);
    if (!message) continue;
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const turn = visibleTurnContent(role, message.content);
    if (turn) turns.push(turn);
  }

  if (!conversationId || turns.length === 0) {
    return { session: null, skippedSubagent: false, malformedLines };
  }
  const bounds = timestampBounds(timestamps, fileStat.mtime.toISOString());
  const session = NormalizedSessionSchema.parse({
    source: "claude-code",
    conversationId,
    device: options.device,
    ...bounds,
    turns,
    sourcePath: path,
    warnings:
      malformedLines > 0
        ? [`Ignored ${malformedLines} malformed JSONL line(s)`]
        : [],
  });
  return { session, skippedSubagent: false, malformedLines };
}
