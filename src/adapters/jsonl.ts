import { readFile } from "node:fs/promises";

export async function readJsonLines(
  path: string,
): Promise<{ records: unknown[]; malformedLines: number }> {
  const input = await readFile(path, "utf8");
  const records: unknown[] = [];
  let malformedLines = 0;

  for (const line of input.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as unknown);
    } catch {
      malformedLines += 1;
    }
  }

  return { records, malformedLines };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
