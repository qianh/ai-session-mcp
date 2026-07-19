import { createHash } from "node:crypto";

import type { DrivePort } from "../drive/drive-port.js";
import type { Embedder } from "./embedder.js";
import {
  chunkText,
  decodeVectorObject,
  encodeVectorObject,
  vectorObjectPath,
  type VectorObject,
} from "./vector-format.js";

type SearchKind = "card" | "session" | "inbox";

interface SearchReference {
  kind: SearchKind;
  source: string;
  conversationId: string;
  startedAt: string;
  updatedAt: string;
  contentSha256: string;
  driveFileId: string;
  drivePath: string;
  vectorPath: string;
}

interface SearchManifest {
  schemaVersion: 1;
  model: string;
  revision: string;
  dimensions: number;
  generatedAt: string;
  references: SearchReference[];
}

export interface SearchOutput {
  query: string;
  indexStatus: "fresh" | "stale";
  results: Array<{
    score: number;
    kind: SearchKind;
    source: string;
    conversationId: string;
    startedAt: string;
    updatedAt: string;
    excerpt: string;
    driveFileId: string;
  }>;
  warnings: Array<{ code: string; message: string }>;
}

interface Frontmatter {
  source: string;
  conversationId: string;
  startedAt: string;
  updatedAt: string;
  contentSha256: string;
}

function parseFrontmatter(markdown: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  const fields = new Map<string, string>();
  for (const line of match?.[1]?.split("\n") ?? []) {
    const separator = line.indexOf(":");
    if (separator > 0)
      fields.set(
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      );
  }
  const contentSha256 =
    fields.get("content_sha256") ??
    createHash("sha256").update(markdown).digest("hex");
  return {
    source: fields.get("source") ?? "brainhub",
    conversationId: fields.get("conversation_id") ?? contentSha256,
    startedAt: fields.get("started_at") ?? new Date(0).toISOString(),
    updatedAt: fields.get("updated_at") ?? new Date(0).toISOString(),
    contentSha256,
  };
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) return -1;
  return left.reduce(
    (sum, value, index) => sum + value * (right[index] ?? 0),
    0,
  );
}

function kindForPath(path: string): SearchKind {
  if (path.startsWith("cards/")) return "card";
  if (path.startsWith("sessions/")) return "session";
  return "inbox";
}

const priority: Record<SearchKind, number> = {
  card: 0.06,
  session: 0.03,
  inbox: 0,
};

export class SearchService {
  readonly #drive: DrivePort;
  readonly #embedder: Embedder;
  readonly #chunkTokens: number;
  readonly #chunkOverlap: number;

  constructor(options: {
    drive: DrivePort;
    embedder: Embedder;
    chunkTokens?: number;
    chunkOverlap?: number;
  }) {
    this.#drive = options.drive;
    this.#embedder = options.embedder;
    this.#chunkTokens = options.chunkTokens ?? 448;
    this.#chunkOverlap = options.chunkOverlap ?? 64;
  }

  async #readManifest(): Promise<{
    manifest: SearchManifest | null;
    etag?: string;
  }> {
    const object = await this.#drive.readPath("_meta/search/v1/manifest.json");
    if (!object) return { manifest: null };
    const manifest = JSON.parse(
      object.bytes.toString("utf8"),
    ) as SearchManifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.model !== this.#embedder.model ||
      manifest.revision !== this.#embedder.revision ||
      manifest.dimensions !== this.#embedder.dimensions
    ) {
      return { manifest: null, etag: object.etag };
    }
    return { manifest, etag: object.etag };
  }

  async sync(retryCount = 0): Promise<SearchManifest> {
    const old = await this.#readManifest();
    const groups = await Promise.all([
      this.#drive.list({ prefix: "cards/" }),
      this.#drive.list({ prefix: "sessions/" }),
      this.#drive.list({ prefix: "inbox/" }),
    ]);
    const entries = groups
      .flat()
      .filter(
        (entry) =>
          entry.mimeType === "text/markdown" || entry.path.endsWith(".md"),
      );
    const references: SearchReference[] = [];
    const vectorCache = new Map<string, VectorObject>();

    for (const entry of entries) {
      const sourceObject = await this.#drive.read(entry.id);
      const markdown = sourceObject.bytes.toString("utf8");
      const metadata = parseFrontmatter(markdown);
      const kind = kindForPath(entry.path);
      const month =
        metadata.startedAt.slice(0, 7).match(/^\d{4}-\d{2}$/u)?.[0] ??
        "1970-01";
      const vectorPath = vectorObjectPath(kind, month, metadata.contentSha256);
      let vectors = vectorCache.get(metadata.contentSha256);
      const existingVector = await this.#drive.readPath(vectorPath);
      let existingVectorValid = false;
      if (existingVector) {
        try {
          vectors = decodeVectorObject(existingVector.bytes);
          existingVectorValid =
            vectors.model === this.#embedder.model &&
            vectors.revision === this.#embedder.revision &&
            vectors.dimensions === this.#embedder.dimensions &&
            vectors.contentSha256 === metadata.contentSha256;
          if (!existingVectorValid) vectors = undefined;
        } catch {
          vectors = undefined;
        }
      }
      if (!vectors) {
        const chunks = chunkText(markdown, {
          maxTokens: this.#chunkTokens,
          overlapTokens: this.#chunkOverlap,
        });
        const embeddings = await this.#embedder.embedPassages(
          chunks.map((chunk) => chunk.text),
        );
        vectors = {
          schemaVersion: 1,
          model: this.#embedder.model,
          revision: this.#embedder.revision,
          dimensions: this.#embedder.dimensions,
          contentSha256: metadata.contentSha256,
          chunks: chunks.map((chunk, index) => ({
            id: chunk.id,
            start: chunk.start,
            end: chunk.end,
            vector: embeddings[index] ?? [],
          })),
        };
      }
      vectorCache.set(metadata.contentSha256, vectors);
      if (!existingVectorValid) {
        await this.#drive.upsert({
          path: vectorPath,
          bytes: encodeVectorObject(vectors),
          mimeType: "application/vnd.brainhub.vector+json",
          appProperties: {
            brainhubVectorSha: metadata.contentSha256,
            brainhubVectorModel: `${this.#embedder.model}@${this.#embedder.revision}`,
          },
        });
      }
      references.push({
        kind,
        source: metadata.source,
        conversationId: metadata.conversationId,
        startedAt: metadata.startedAt,
        updatedAt: metadata.updatedAt,
        contentSha256: metadata.contentSha256,
        driveFileId: entry.id,
        drivePath: entry.path,
        vectorPath,
      });
    }

    const manifest: SearchManifest = {
      schemaVersion: 1,
      model: this.#embedder.model,
      revision: this.#embedder.revision,
      dimensions: this.#embedder.dimensions,
      generatedAt: new Date().toISOString(),
      references,
    };
    try {
      await this.#drive.upsert({
        path: "_meta/search/v1/manifest.json",
        bytes: Buffer.from(JSON.stringify(manifest)),
        mimeType: "application/json",
        ...(old.etag ? { ifMatch: old.etag } : {}),
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === 412 && retryCount < 2) {
        return this.sync(retryCount + 1);
      }
      throw error;
    }
    return manifest;
  }

  async search(input: {
    query: string;
    limit: number;
    sources?: string[];
    since?: string;
    until?: string;
  }): Promise<SearchOutput> {
    let indexStatus: "fresh" | "stale" = "fresh";
    const warnings: Array<{ code: string; message: string }> = [];
    let manifest: SearchManifest | null;
    try {
      manifest = await this.sync();
    } catch {
      indexStatus = "stale";
      warnings.push({
        code: "INDEX_STALE",
        message: "Search index refresh failed; using the last valid index",
      });
      manifest = (await this.#readManifest()).manifest;
    }
    if (!manifest)
      return { query: input.query, indexStatus, results: [], warnings };

    const queryVector = await this.#embedder.embedQuery(input.query);
    const keywords =
      input.query.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
    const scored: Array<SearchOutput["results"][number]> = [];
    for (const reference of manifest.references) {
      if (input.sources?.length && !input.sources.includes(reference.source))
        continue;
      if (input.since && reference.updatedAt < input.since) continue;
      if (input.until && reference.updatedAt > input.until) continue;
      try {
        const [vectorFile, sourceFile] = await Promise.all([
          this.#drive.readPath(reference.vectorPath),
          this.#drive.read(reference.driveFileId),
        ]);
        if (!vectorFile) continue;
        const object = decodeVectorObject(vectorFile.bytes);
        const markdown = sourceFile.bytes.toString("utf8");
        let best = { score: -1, start: 0, end: Math.min(markdown.length, 320) };
        for (const chunk of object.chunks) {
          const score = cosine(queryVector, chunk.vector);
          if (score > best.score)
            best = { score, start: chunk.start, end: chunk.end };
        }
        const lower = markdown.toLowerCase();
        const lexical =
          keywords.length > 0
            ? keywords.filter((keyword) => lower.includes(keyword)).length /
              keywords.length
            : 0;
        const score =
          best.score * 0.85 + lexical * 0.15 + priority[reference.kind];
        scored.push({
          score: Number(score.toFixed(6)),
          kind: reference.kind,
          source: reference.source,
          conversationId: reference.conversationId,
          startedAt: reference.startedAt,
          updatedAt: reference.updatedAt,
          excerpt: markdown
            .slice(best.start, Math.min(best.end, best.start + 360))
            .replace(/\s+/gu, " ")
            .trim(),
          driveFileId: reference.driveFileId,
        });
      } catch {
        indexStatus = "stale";
        if (!warnings.some((warning) => warning.code === "INDEX_STALE")) {
          warnings.push({
            code: "INDEX_STALE",
            message: "One or more search objects could not be read",
          });
        }
      }
    }

    scored.sort(
      (left, right) =>
        right.score - left.score ||
        right.updatedAt.localeCompare(left.updatedAt),
    );
    const deduplicated = new Map<string, SearchOutput["results"][number]>();
    for (const result of scored) {
      if (!deduplicated.has(result.conversationId))
        deduplicated.set(result.conversationId, result);
    }
    return {
      query: input.query,
      indexStatus,
      results: [...deduplicated.values()].slice(0, input.limit),
      warnings,
    };
  }
}
