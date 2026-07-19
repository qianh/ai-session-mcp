import type { NormalizedSession } from "../domain/session.js";

export interface AdapterOptions {
  device: string;
  includeSubagents: boolean;
}

export interface AdapterResult {
  session: NormalizedSession | null;
  skippedSubagent: boolean;
  malformedLines: number;
}
