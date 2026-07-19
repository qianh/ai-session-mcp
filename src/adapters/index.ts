import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import fg from "fast-glob";

import type { NormalizedSession, SessionSource } from "../domain/session.js";
import { parseClaudeSession } from "./claude.js";
import { parseCodexSession } from "./codex.js";
import { parseGrokSession } from "./grok.js";
import type { AdapterResult } from "./types.js";

export interface DiscoveryOptions {
  device: string;
  includeSubagents: boolean;
  sources: SessionSource[];
  paths: { claude: string[]; codex: string[]; grok: string[] };
  modifiedAfter?: Partial<Record<SessionSource, string>>;
  includePaths?: string[];
}

export interface DiscoveryStatus {
  discovered: number;
  captured: number;
  skippedSubagents: number;
  malformed: number;
  errors: number;
}

export interface DiscoveryResult {
  sessions: NormalizedSession[];
  skippedSubagents: number;
  malformed: number;
  warnings: Array<{ code: string; message: string }>;
  status: Record<"claude" | "codex" | "grok", DiscoveryStatus>;
}

const emptyStatus = (): DiscoveryStatus => ({
  discovered: 0,
  captured: 0,
  skippedSubagents: 0,
  malformed: 0,
  errors: 0,
});

async function globFiles(patterns: string[]): Promise<string[]> {
  return fg(patterns, {
    absolute: true,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
}

async function incrementalFiles(
  paths: string[],
  modifiedAfter: string | undefined,
  includePaths: Set<string>,
  sourcePath: (path: string) => string = (path) => path,
): Promise<string[]> {
  if (!modifiedAfter) return paths;
  const candidates = await Promise.all(
    paths.map(async (path) => {
      if (includePaths.has(path) || includePaths.has(sourcePath(path)))
        return path;
      try {
        return (await stat(path)).mtime.toISOString() > modifiedAfter
          ? path
          : null;
      } catch {
        return path;
      }
    }),
  );
  return candidates.filter((path): path is string => path !== null);
}

export async function discoverSessions(
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const status = {
    claude: emptyStatus(),
    codex: emptyStatus(),
    grok: emptyStatus(),
  };
  const output: DiscoveryResult = {
    sessions: [],
    skippedSubagents: 0,
    malformed: 0,
    warnings: [],
    status,
  };
  const parserOptions = {
    device: options.device,
    includeSubagents: options.includeSubagents,
  };
  const includePaths = new Set(options.includePaths ?? []);
  const work: Array<{
    name: keyof typeof status;
    path: string;
    parse: () => Promise<AdapterResult>;
  }> = [];

  if (options.sources.includes("claude-code")) {
    const paths = await incrementalFiles(
      await globFiles(
        options.paths.claude.map((root) => join(root, "**", "*.jsonl")),
      ),
      options.modifiedAfter?.["claude-code"],
      includePaths,
    );
    status.claude.discovered = paths.length;
    work.push(
      ...paths.map((path) => ({
        name: "claude" as const,
        path,
        parse: () => parseClaudeSession(path, parserOptions),
      })),
    );
  }
  if (options.sources.includes("codex")) {
    const paths = await incrementalFiles(
      await globFiles(
        options.paths.codex.map((root) => join(root, "**", "rollout-*.jsonl")),
      ),
      options.modifiedAfter?.codex,
      includePaths,
    );
    status.codex.discovered = paths.length;
    work.push(
      ...paths.map((path) => ({
        name: "codex" as const,
        path,
        parse: () => parseCodexSession(path, parserOptions),
      })),
    );
  }
  if (options.sources.includes("grok-build")) {
    const histories = await incrementalFiles(
      await globFiles(
        options.paths.grok.map((root) =>
          join(root, "**", "chat_history.jsonl"),
        ),
      ),
      options.modifiedAfter?.["grok-build"],
      includePaths,
      dirname,
    );
    status.grok.discovered = histories.length;
    work.push(
      ...histories.map((path) => ({
        name: "grok" as const,
        path: dirname(path),
        parse: () => parseGrokSession(dirname(path), parserOptions),
      })),
    );
  }

  for (const item of work) {
    try {
      const result = await item.parse();
      status[item.name].malformed += result.malformedLines;
      output.malformed += result.malformedLines;
      if (result.skippedSubagent) {
        status[item.name].skippedSubagents += 1;
        output.skippedSubagents += 1;
      }
      if (result.session) {
        status[item.name].captured += 1;
        output.sessions.push(result.session);
      }
    } catch {
      status[item.name].errors += 1;
      output.warnings.push({
        code: "SOURCE_PARSE_FAILED",
        message: `${item.name} session could not be parsed: ${item.path}`,
      });
    }
  }
  output.sessions.sort((left, right) =>
    left.updatedAt.localeCompare(right.updatedAt),
  );
  return output;
}
