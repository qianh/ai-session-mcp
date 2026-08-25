import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type {
  BackfillDecisionInput,
  BackfillState,
  BackfillUploadInput,
  DeviceState,
  PendingSession,
  SessionState,
  StateStore,
} from "./store.js";
import { SessionSourceSchema, type SessionSource } from "../domain/session.js";

interface SessionRow {
  conversation_key: string;
  source: SessionState["source"];
  conversation_id: string;
  source_path: string;
  source_updated_at: string;
  content_sha256: string;
  status: SessionState["status"];
  attempts: number;
  retryable: number;
  drive_file_id: string | null;
  uploaded_at: string | null;
  last_error_code: string | null;
}

interface BackfillRow {
  decision: BackfillState["decision"];
  sessions: number;
  bytes: number;
  uploaded: number;
  decidedAt: string;
  completedAt: string | null;
  sources: string | null;
}

function parseBackfillSources(value: string | null): SessionSource[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((source) => SessionSourceSchema.parse(source));
  } catch {
    return null;
  }
}

function mapSession(row: SessionRow): SessionState {
  return {
    conversationKey: row.conversation_key,
    source: row.source,
    conversationId: row.conversation_id,
    sourcePath: row.source_path,
    sourceUpdatedAt: row.source_updated_at,
    contentSha256: row.content_sha256,
    status: row.status,
    attempts: row.attempts,
    retryable: row.retryable === 1,
    driveFileId: row.drive_file_id,
    uploadedAt: row.uploaded_at,
    lastErrorCode: row.last_error_code,
  };
}

export class SqliteStateStore implements StateStore {
  readonly #database: Database.Database;

  constructor(path: string, options: { legacyPath?: string } = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new Database(path);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    this.#migrate();
    if (options.legacyPath) this.#migrateLegacy(options.legacyPath, path);
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS device (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        conversation_key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_updated_at TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'uploaded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        retryable INTEGER NOT NULL DEFAULT 1,
        drive_file_id TEXT,
        uploaded_at TEXT,
        last_error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_pending
        ON sessions(status, retryable, source_updated_at);
      CREATE TABLE IF NOT EXISTS discovery_watermarks (
        source TEXT PRIMARY KEY,
        scanned_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS setup_backfill (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        decision TEXT NOT NULL CHECK (decision IN ('accepted', 'declined')),
        sessions INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        uploaded INTEGER NOT NULL DEFAULT 0,
        decided_at TEXT NOT NULL,
        completed_at TEXT,
        sources TEXT
      );
    `);
    const backfillColumns = this.#database.pragma(
      "table_info(setup_backfill)",
    ) as Array<{ name: string }>;
    if (!backfillColumns.some(({ name }) => name === "sources")) {
      this.#database.exec("ALTER TABLE setup_backfill ADD COLUMN sources TEXT");
    }
  }

  #migrateLegacy(legacyPath: string, currentPath: string): void {
    const migration = "legacy-account-state-v1";
    const sourceClaim = `${migration}-claimed`;
    if (
      resolve(legacyPath) === resolve(currentPath) ||
      !existsSync(legacyPath)
    ) {
      return;
    }

    this.#database.prepare("ATTACH DATABASE ? AS legacy_state").run(legacyPath);
    try {
      const requiredTables = ["device", "sessions", "discovery_watermarks"];
      const available = new Set(
        (
          this.#database
            .prepare(
              "SELECT name FROM legacy_state.sqlite_master WHERE type = 'table'",
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name),
      );
      if (!requiredTables.every((table) => available.has(table))) return;

      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS legacy_state.state_migrations (
          name TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
      const targetAlreadyMigrated = Boolean(
        this.#database
          .prepare("SELECT 1 FROM state_migrations WHERE name = ?")
          .get(migration),
      );
      if (targetAlreadyMigrated) {
        this.#database
          .prepare(
            "INSERT OR IGNORE INTO legacy_state.state_migrations(name, applied_at) VALUES (?, ?)",
          )
          .run(sourceClaim, new Date().toISOString());
        return;
      }

      this.#database.transaction(() => {
        const claimed = this.#database
          .prepare(
            "INSERT OR IGNORE INTO legacy_state.state_migrations(name, applied_at) VALUES (?, ?)",
          )
          .run(sourceClaim, new Date().toISOString());
        if (claimed.changes === 0) return;
        this.#database.exec(`
          INSERT OR REPLACE INTO device(singleton, id, name, created_at)
          SELECT singleton, id, name, created_at FROM legacy_state.device;

          INSERT OR IGNORE INTO sessions(
            conversation_key, source, conversation_id, source_path,
            source_updated_at, content_sha256, status, attempts, retryable,
            drive_file_id, uploaded_at, last_error_code
          )
          SELECT
            conversation_key, source, conversation_id, source_path,
            source_updated_at, content_sha256, status, attempts, retryable,
            drive_file_id, uploaded_at, last_error_code
          FROM legacy_state.sessions;

          INSERT INTO discovery_watermarks(source, scanned_at)
          SELECT source, scanned_at FROM legacy_state.discovery_watermarks
          WHERE true
          ON CONFLICT(source) DO UPDATE SET scanned_at =
            MIN(discovery_watermarks.scanned_at, excluded.scanned_at);
        `);
        this.#database
          .prepare(
            "INSERT INTO state_migrations(name, applied_at) VALUES (?, ?)",
          )
          .run(migration, new Date().toISOString());
      })();
    } finally {
      this.#database.exec("DETACH DATABASE legacy_state");
    }
  }

  getOrCreateDevice(name: string): DeviceState {
    const existing = this.#database
      .prepare(
        "SELECT id, name, created_at AS createdAt FROM device WHERE singleton = 1",
      )
      .get() as DeviceState | undefined;
    if (existing) {
      if (existing.name !== name) {
        this.#database
          .prepare("UPDATE device SET name = ? WHERE singleton = 1")
          .run(name);
      }
      return { ...existing, name };
    }
    const device = {
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
    };
    this.#database
      .prepare(
        "INSERT INTO device(singleton, id, name, created_at) VALUES (1, ?, ?, ?)",
      )
      .run(device.id, device.name, device.createdAt);
    return device;
  }

  markPending(session: PendingSession): boolean {
    const current = this.getSession(session.conversationKey);
    if (
      current?.status === "uploaded" &&
      current.contentSha256 === session.contentSha256
    ) {
      return false;
    }
    this.#database
      .prepare(
        `
        INSERT INTO sessions(
          conversation_key, source, conversation_id, source_path,
          source_updated_at, content_sha256, status, attempts, retryable
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 1)
        ON CONFLICT(conversation_key) DO UPDATE SET
          source = excluded.source,
          conversation_id = excluded.conversation_id,
          source_path = excluded.source_path,
          source_updated_at = excluded.source_updated_at,
          content_sha256 = excluded.content_sha256,
          status = 'pending',
          attempts = CASE
            WHEN sessions.content_sha256 = excluded.content_sha256 THEN sessions.attempts
            ELSE 0
          END,
          retryable = 1,
          drive_file_id = CASE
            WHEN sessions.content_sha256 = excluded.content_sha256 THEN sessions.drive_file_id
            ELSE NULL
          END,
          uploaded_at = CASE
            WHEN sessions.content_sha256 = excluded.content_sha256 THEN sessions.uploaded_at
            ELSE NULL
          END,
          last_error_code = NULL
      `,
      )
      .run(
        session.conversationKey,
        session.source,
        session.conversationId,
        session.sourcePath,
        session.sourceUpdatedAt,
        session.contentSha256,
      );
    return true;
  }

  markFailed(
    conversationKey: string,
    errorCode: string,
    retryable: boolean,
  ): void {
    this.#database
      .prepare(
        `
        UPDATE sessions
        SET status = 'failed', attempts = attempts + 1,
            retryable = ?, last_error_code = ?
        WHERE conversation_key = ?
      `,
      )
      .run(retryable ? 1 : 0, errorCode, conversationKey);
  }

  markUploaded(
    conversationKey: string,
    driveFileId: string,
    uploadedAt: string,
  ): void {
    this.#database
      .prepare(
        `
        UPDATE sessions
        SET status = 'uploaded', retryable = 0, drive_file_id = ?,
            uploaded_at = ?, last_error_code = NULL
        WHERE conversation_key = ?
      `,
      )
      .run(driveFileId, uploadedAt, conversationKey);
  }

  getSession(conversationKey: string): SessionState | null {
    const row = this.#database
      .prepare("SELECT * FROM sessions WHERE conversation_key = ?")
      .get(conversationKey) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  listPending(limit: number): SessionState[] {
    const rows = this.#database
      .prepare(
        `
        SELECT * FROM sessions
        WHERE status = 'pending' OR (status = 'failed' AND retryable = 1)
        ORDER BY source_updated_at, conversation_key
        LIMIT ?
      `,
      )
      .all(limit) as SessionRow[];
    return rows.map(mapSession);
  }

  getDiscoveryWatermark(source: SessionState["source"]): string | null {
    const row = this.#database
      .prepare(
        "SELECT scanned_at AS scannedAt FROM discovery_watermarks WHERE source = ?",
      )
      .get(source) as { scannedAt: string } | undefined;
    return row?.scannedAt ?? null;
  }

  setDiscoveryWatermark(
    source: SessionState["source"],
    scannedAt: string,
  ): void {
    this.#database
      .prepare(
        `
        INSERT INTO discovery_watermarks(source, scanned_at) VALUES (?, ?)
        ON CONFLICT(source) DO UPDATE SET scanned_at = excluded.scanned_at
      `,
      )
      .run(source, scannedAt);
  }

  getBackfillState(): BackfillState | null {
    const row = this.#database
      .prepare(
        `
          SELECT decision, sessions, bytes, uploaded,
                 decided_at AS decidedAt, completed_at AS completedAt, sources
          FROM setup_backfill WHERE singleton = 1
        `,
      )
      .get() as BackfillRow | undefined;
    return row ? { ...row, sources: parseBackfillSources(row.sources) } : null;
  }

  recordBackfillDecision(input: BackfillDecisionInput): void {
    this.#database.transaction(() => {
      const inserted = this.#database
        .prepare(
          `
            INSERT OR IGNORE INTO setup_backfill(
              singleton, decision, sessions, bytes, uploaded,
              decided_at, completed_at, sources
            ) VALUES (1, ?, ?, ?, 0, ?, ?, ?)
          `,
        )
        .run(
          input.decision,
          input.sessions,
          input.bytes,
          input.decidedAt,
          input.decision === "declined" ? input.decidedAt : null,
          input.sources ? JSON.stringify(input.sources) : null,
        );
      if (inserted.changes === 0 || input.decision !== "declined") return;
      const watermark = this.#database.prepare(`
        INSERT INTO discovery_watermarks(source, scanned_at) VALUES (?, ?)
        ON CONFLICT(source) DO UPDATE SET scanned_at = excluded.scanned_at
      `);
      for (const source of [
        "claude-code",
        "codex",
        "grok-build",
        "cursor",
      ] as const) {
        watermark.run(source, input.decidedAt);
      }
    })();
  }

  recordBackfillUpload(input: BackfillUploadInput): void {
    const updated = this.#database
      .prepare(
        `
          UPDATE setup_backfill
          SET uploaded = uploaded + ?,
              completed_at = CASE WHEN ? = 0 THEN ? ELSE completed_at END
          WHERE singleton = 1 AND decision = 'accepted'
        `,
      )
      .run(input.uploaded, input.pending, input.recordedAt);
    if (updated.changes === 0) {
      throw new Error("Accepted backfill decision is required before upload");
    }
  }

  close(): void {
    this.#database.close();
  }
}
