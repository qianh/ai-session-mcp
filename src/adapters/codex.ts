import { basename } from "node:path";
import { stat } from "node:fs/promises";

import { NormalizedSessionSchema, type Turn } from "../domain/session.js";
import { visibleTurnContent, timestampBounds } from "./content.js";
import { asRecord, asString, readJsonLines } from "./jsonl.js";
import type { AdapterOptions, AdapterResult } from "./types.js";

export async function parseCodexSession(
  path: string,
  options: AdapterOptions,
): Promise<AdapterResult> {
  const [{ records, malformedLines }, fileStat] = await Promise.all([
    readJsonLines(path),
    stat(path),
  ]);
  const objects = records.map(asRecord).filter((value) => value !== null);
  const metadata = objects.find((record) => record.type === "session_meta");
  const metaPayload = asRecord(metadata?.payload);
  const isSubagent = asRecord(metaPayload?.source)?.subagent !== undefined;
  if (isSubagent && !options.includeSubagents) {
    return { session: null, skippedSubagent: true, malformedLines };
  }

  const turns: Turn[] = [];
  const timestamps: Array<string | null> = [];
  for (const record of objects) {
    timestamps.push(asString(record.timestamp));
    if (record.type !== "response_item") continue;
    const payload = asRecord(record.payload);
    if (payload?.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const turn = visibleTurnContent(role, payload.content);
    if (turn) turns.push(turn);
  }

  const conversationId = asString(metaPayload?.id) ?? basename(path, ".jsonl");
  if (turns.length === 0) {
    return { session: null, skippedSubagent: false, malformedLines };
  }
  const bounds = timestampBounds(
    [asString(metaPayload?.timestamp), ...timestamps],
    fileStat.mtime.toISOString(),
  );
  const session = NormalizedSessionSchema.parse({
    source: "codex",
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
