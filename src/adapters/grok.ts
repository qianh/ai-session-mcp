import { basename, join } from "node:path";
import { readFile, stat } from "node:fs/promises";

import { NormalizedSessionSchema, type Turn } from "../domain/session.js";
import { timestampBounds, visibleTurnContent } from "./content.js";
import { asRecord, asString, readJsonLines } from "./jsonl.js";
import type { AdapterOptions, AdapterResult } from "./types.js";

export async function parseGrokSession(
  directory: string,
  options: AdapterOptions,
): Promise<AdapterResult> {
  const historyPath = join(directory, "chat_history.jsonl");
  const [{ records, malformedLines }, summaryText, fileStat] =
    await Promise.all([
      readJsonLines(historyPath),
      readFile(join(directory, "summary.json"), "utf8"),
      stat(historyPath),
    ]);
  const summary = asRecord(JSON.parse(summaryText) as unknown);
  const isSubagent = summary?.session_kind === "subagent";
  if (isSubagent && !options.includeSubagents) {
    return { session: null, skippedSubagent: true, malformedLines };
  }

  const turns: Turn[] = [];
  for (const value of records) {
    const record = asRecord(value);
    if (!record || (record.type !== "user" && record.type !== "assistant"))
      continue;
    const turn = visibleTurnContent(record.type, record.content);
    if (turn) turns.push(turn);
  }
  if (turns.length === 0) {
    return { session: null, skippedSubagent: false, malformedLines };
  }
  const bounds = timestampBounds(
    [asString(summary?.created_at), asString(summary?.updated_at)],
    fileStat.mtime.toISOString(),
  );
  const session = NormalizedSessionSchema.parse({
    source: "grok-build",
    conversationId: basename(directory),
    device: options.device,
    ...bounds,
    turns,
    sourcePath: directory,
    warnings:
      malformedLines > 0
        ? [`Ignored ${malformedLines} malformed JSONL line(s)`]
        : [],
  });
  return { session, skippedSubagent: false, malformedLines };
}
