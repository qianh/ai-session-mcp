import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { redactText } from "../capture/redact.js";
import type { DrivePort } from "../drive/drive-port.js";
import { chunkText } from "./chunk-text.js";
import type { Embedder } from "./embedder.js";

interface Frontmatter {
  source: string;
  conversationId: string;
  startedAt: string;
  updatedAt: string;
  contentSha256: string;
}

interface IndexedChunk {
  driveFileId: string;
  drivePath: string;
  source: string;
  conversationId: string;
  startedAt: string;
  updatedAt: string;
  contentSha256: string;
  chunkId: string;
  text: string;
  vector: number[] | null;
}

interface ChunkRow {
  drive_file_id: string;
  drive_path: string;
  source: string;
  conversation_id: string;
  started_at: string;
  updated_at: string;
  content_sha256: string;
  chunk_id: string;
  text: string;
  vector: string | null;
}

export interface SearchOutput {
  query: string;
  indexStatus: "fresh" | "stale";
  searchMode: "semantic" | "keyword";
  results: Array<{
    score: number;
    source: string;
    conversationId: string;
    startedAt: string;
    updatedAt: string;
    excerpt: string;
  }>;
  warnings: Array<{ code: string; message: string }>;
}

function parseFrontmatter(markdown: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  const fields = new Map<string, string>();
  for (const line of match?.[1]?.split("\n") ?? []) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      fields.set(
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      );
    }
  }
  const contentSha256 =
    fields.get("content_sha256") ??
    createHash("sha256").update(markdown).digest("hex");
  return {
    source: fields.get("source") ?? "unknown",
    conversationId: fields.get("conversation_id") ?? contentSha256,
    startedAt: fields.get("started_at") ?? new Date(0).toISOString(),
    updatedAt: fields.get("updated_at") ?? new Date(0).toISOString(),
    contentSha256,
  };
}

function searchableText(markdown: string): string {
  const withoutImages = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "[image omitted]")
    .replace(/<img\b[^>]*>/giu, "[image omitted]");
  return redactText(withoutImages).text;
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) return -1;
  return left.reduce(
    (sum, value, index) => sum + value * (right[index] ?? 0),
    0,
  );
}

function addWarning(
  warnings: SearchOutput["warnings"],
  warning: SearchOutput["warnings"][number],
): void {
  if (!warnings.some(({ code }) => code === warning.code)) {
    warnings.push(warning);
  }
}

export class SearchService {
  readonly #drive: DrivePort;
  readonly #embedder: Embedder;
  readonly #indexPath: string;
  readonly #chunkTokens: number;
  readonly #chunkOverlap: number;

  constructor(options: {
    drive: DrivePort;
    embedder: Embedder;
    indexPath: string;
    chunkTokens?: number;
    chunkOverlap?: number;
  }) {
    this.#drive = options.drive;
    this.#embedder = options.embedder;
    this.#indexPath = options.indexPath;
    this.#chunkTokens = options.chunkTokens ?? 448;
    this.#chunkOverlap = options.chunkOverlap ?? 64;
  }

  #indexFingerprint(): string {
    return JSON.stringify({
      model: this.#embedder.model,
      revision: this.#embedder.revision,
      dimensions: this.#embedder.dimensions,
      chunkTokens: this.#chunkTokens,
      chunkOverlap: this.#chunkOverlap,
    });
  }

  #database(): Database.Database {
    mkdirSync(dirname(this.#indexPath), { recursive: true });
    const database = new Database(this.#indexPath);
    database.pragma("journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS search_documents (
        drive_file_id TEXT PRIMARY KEY,
        drive_path TEXT NOT NULL,
        source TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        content_sha256 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS search_chunks (
        drive_file_id TEXT NOT NULL REFERENCES search_documents(drive_file_id) ON DELETE CASCADE,
        chunk_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        vector TEXT,
        PRIMARY KEY(drive_file_id, chunk_id)
      );
      CREATE TABLE IF NOT EXISTS search_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS search_documents_session
        ON search_documents(source, conversation_id, updated_at);
    `);
    database.pragma("foreign_keys = ON");
    return database;
  }

  async sync(): Promise<{
    documents: number;
    warnings: SearchOutput["warnings"];
  }> {
    const stateDatabase = this.#database();
    let cursor: string | undefined;
    try {
      const metadata = Object.fromEntries(
        (
          stateDatabase
            .prepare("SELECT key, value FROM search_metadata")
            .all() as Array<{ key: string; value: string }>
        ).map(({ key, value }) => [key, value]),
      );
      const missingVector = stateDatabase
        .prepare("SELECT 1 FROM search_chunks WHERE vector IS NULL LIMIT 1")
        .get();
      if (
        metadata.index_fingerprint === this.#indexFingerprint() &&
        !missingVector
      ) {
        cursor = metadata.drive_cursor;
      }
    } finally {
      stateDatabase.close();
    }
    const changes = await this.#drive.changes({
      prefix: "inbox/",
      ...(cursor ? { cursor } : {}),
    });
    const entries = changes.entries.filter(
      (entry) =>
        entry.path.startsWith("inbox/") &&
        (entry.mimeType === "text/markdown" || entry.path.endsWith(".md")),
    );
    const removedIds = new Set(changes.removedIds);
    for (const entry of changes.entries) {
      if (!entries.includes(entry)) removedIds.add(entry.id);
    }
    const chunks: IndexedChunk[] = [];
    const warnings: SearchOutput["warnings"] = [];
    let modelAvailable = true;
    for (const entry of entries) {
      const sourceObject = await this.#drive.read(entry.id);
      const markdown = sourceObject.bytes.toString("utf8");
      const metadata = parseFrontmatter(markdown);
      const textChunks = chunkText(searchableText(markdown), {
        maxTokens: this.#chunkTokens,
        overlapTokens: this.#chunkOverlap,
      });
      let vectors: number[][] = [];
      if (modelAvailable) {
        try {
          vectors = await this.#embedder.embedPassages(
            textChunks.map((chunk) => chunk.text),
          );
        } catch {
          modelAvailable = false;
          addWarning(warnings, {
            code: "MODEL_UNAVAILABLE_KEYWORD_FALLBACK",
            message: "Embedding model is unavailable; using keyword search",
          });
        }
      }
      chunks.push(
        ...textChunks.map((chunk, index) => ({
          driveFileId: entry.id,
          drivePath: entry.path,
          ...metadata,
          chunkId: chunk.id,
          text: chunk.text,
          vector: vectors[index] ?? null,
        })),
      );
    }

    const database = this.#database();
    try {
      const replace = database.transaction(() => {
        if (changes.reset) {
          database.prepare("DELETE FROM search_chunks").run();
          database.prepare("DELETE FROM search_documents").run();
        }
        const deleteDocument = database.prepare(
          "DELETE FROM search_documents WHERE drive_file_id = ?",
        );
        for (const id of [...removedIds, ...entries.map((entry) => entry.id)]) {
          deleteDocument.run(id);
        }
        const insertDocument = database.prepare(`
          INSERT INTO search_documents(
            drive_file_id, drive_path, source, conversation_id,
            started_at, updated_at, content_sha256
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const insertChunk = database.prepare(`
          INSERT INTO search_chunks(drive_file_id, chunk_id, text, vector)
          VALUES (?, ?, ?, ?)
        `);
        const documents = new Set<string>();
        for (const chunk of chunks) {
          if (!documents.has(chunk.driveFileId)) {
            insertDocument.run(
              chunk.driveFileId,
              chunk.drivePath,
              chunk.source,
              chunk.conversationId,
              chunk.startedAt,
              chunk.updatedAt,
              chunk.contentSha256,
            );
            documents.add(chunk.driveFileId);
          }
          insertChunk.run(
            chunk.driveFileId,
            chunk.chunkId,
            chunk.text,
            chunk.vector ? JSON.stringify(chunk.vector) : null,
          );
        }
        const metadata = database.prepare(`
          INSERT INTO search_metadata(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);
        metadata.run("model", this.#embedder.model);
        metadata.run("revision", this.#embedder.revision);
        metadata.run("index_fingerprint", this.#indexFingerprint());
        metadata.run("generated_at", new Date().toISOString());
        metadata.run("drive_cursor", changes.cursor);
      });
      replace();
      const count = database
        .prepare("SELECT COUNT(*) AS count FROM search_documents")
        .get() as { count: number };
      return { documents: count.count, warnings };
    } finally {
      database.close();
    }
  }

  status(): {
    ready: boolean;
    documents: number;
    cursor?: string;
    generatedAt?: string;
  } {
    if (!existsSync(this.#indexPath)) return { ready: false, documents: 0 };
    const database = this.#database();
    try {
      const count = database
        .prepare("SELECT COUNT(*) AS count FROM search_documents")
        .get() as { count: number };
      const metadata = Object.fromEntries(
        (
          database
            .prepare("SELECT key, value FROM search_metadata")
            .all() as Array<{ key: string; value: string }>
        ).map(({ key, value }) => [key, value]),
      );
      return {
        ready: Boolean(metadata.drive_cursor),
        documents: count.count,
        ...(metadata.drive_cursor ? { cursor: metadata.drive_cursor } : {}),
        ...(metadata.generated_at
          ? { generatedAt: metadata.generated_at }
          : {}),
      };
    } finally {
      database.close();
    }
  }

  async search(input: {
    query: string;
    limit: number;
    sources?: string[];
    since?: string;
    until?: string;
  }): Promise<SearchOutput> {
    let indexStatus: SearchOutput["indexStatus"] = "fresh";
    const warnings: SearchOutput["warnings"] = [];
    try {
      const synced = await this.sync();
      warnings.push(...synced.warnings);
    } catch {
      indexStatus = "stale";
      addWarning(warnings, {
        code: "INDEX_STALE",
        message: "Search index refresh failed; using the last local index",
      });
    }

    const database = this.#database();
    let rows: ChunkRow[];
    try {
      rows = database
        .prepare(
          `
          SELECT d.*, c.chunk_id, c.text, c.vector
          FROM search_documents d
          JOIN search_chunks c ON c.drive_file_id = d.drive_file_id
        `,
        )
        .all() as ChunkRow[];
    } finally {
      database.close();
    }

    let queryVector: number[] | null = null;
    if (rows.some((row) => row.vector !== null)) {
      try {
        queryVector = await this.#embedder.embedQuery(input.query);
      } catch {
        addWarning(warnings, {
          code: "MODEL_UNAVAILABLE_KEYWORD_FALLBACK",
          message: "Embedding model is unavailable; using keyword search",
        });
      }
    } else if (rows.length > 0) {
      addWarning(warnings, {
        code: "MODEL_UNAVAILABLE_KEYWORD_FALLBACK",
        message: "Embedding model is unavailable; using keyword search",
      });
    }
    const searchMode: SearchOutput["searchMode"] = queryVector
      ? "semantic"
      : "keyword";
    const keywords =
      input.query.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
    const scored = rows
      .filter(
        (row) =>
          (!input.sources?.length || input.sources.includes(row.source)) &&
          (!input.since || row.updated_at >= input.since) &&
          (!input.until || row.updated_at <= input.until),
      )
      .map((row) => {
        const lower = row.text.toLowerCase();
        const lexical =
          keywords.length > 0
            ? keywords.filter((keyword) => lower.includes(keyword)).length /
              keywords.length
            : 0;
        const vector = row.vector ? (JSON.parse(row.vector) as number[]) : null;
        const semantic =
          queryVector && vector ? cosine(queryVector, vector) : 0;
        return {
          score: Number(
            (queryVector ? semantic * 0.85 + lexical * 0.15 : lexical).toFixed(
              6,
            ),
          ),
          source: row.source,
          conversationId: row.conversation_id,
          startedAt: row.started_at,
          updatedAt: row.updated_at,
          excerpt: row.text.replace(/\s+/gu, " ").trim().slice(0, 360),
        };
      })
      .filter((result) => queryVector !== null || result.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.updatedAt.localeCompare(left.updatedAt),
      );
    const deduplicated = new Map<string, SearchOutput["results"][number]>();
    for (const result of scored) {
      const key = `${result.source}:${result.conversationId}`;
      if (!deduplicated.has(key)) deduplicated.set(key, result);
    }
    return {
      query: input.query,
      indexStatus,
      searchMode,
      results: [...deduplicated.values()].slice(0, input.limit),
      warnings,
    };
  }
}
