import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStateStore } from "../../src/state/sqlite-store.js";

const stores: SqliteStateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function createStore(): Promise<SqliteStateStore> {
  const directory = await mkdtemp(join(tmpdir(), "brainhub-state-"));
  const store = new SqliteStateStore(join(directory, "state.sqlite"));
  stores.push(store);
  return store;
}

describe("SQLite state store", () => {
  it("creates one durable device identity", async () => {
    const store = await createStore();
    const first = store.getOrCreateDevice("macbook");
    const second = store.getOrCreateDevice("renamed");

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toEqual({ ...first, name: "renamed" });
  });

  it("records only operational upload state and resumes failed work", async () => {
    const store = await createStore();
    store.markPending({
      conversationKey: "key-1",
      source: "codex",
      conversationId: "conversation-1",
      sourcePath: "/read-only/source.jsonl",
      sourceUpdatedAt: "2026-07-18T02:00:00.000Z",
      contentSha256: "a".repeat(64),
    });
    store.markFailed("key-1", "DRIVE_UNAVAILABLE", true);

    expect(store.getSession("key-1")).toMatchObject({
      status: "failed",
      attempts: 1,
      retryable: true,
      lastErrorCode: "DRIVE_UNAVAILABLE",
    });
    expect(store.listPending(10).map((row) => row.conversationKey)).toEqual([
      "key-1",
    ]);

    store.markUploaded("key-1", "file-1", "2026-07-18T02:05:00.000Z");
    expect(store.listPending(10)).toEqual([]);
    expect(JSON.stringify(store.getSession("key-1"))).not.toContain(
      "message body",
    );
  });

  it("requeues a canonical conversation when its content hash changes", async () => {
    const store = await createStore();
    const base = {
      conversationKey: "key-2",
      source: "claude-code" as const,
      conversationId: "conversation-2",
      sourcePath: "/read-only/source.jsonl",
      sourceUpdatedAt: "2026-07-18T02:00:00.000Z",
    };
    store.markPending({ ...base, contentSha256: "a".repeat(64) });
    store.markUploaded("key-2", "file-2", "2026-07-18T02:05:00.000Z");
    expect(store.markPending({ ...base, contentSha256: "a".repeat(64) })).toBe(
      false,
    );
    expect(store.markPending({ ...base, contentSha256: "b".repeat(64) })).toBe(
      true,
    );
    expect(store.getSession("key-2")?.status).toBe("pending");
  });

  it("persists independent discovery watermarks for each source", async () => {
    const store = await createStore();

    expect(store.getDiscoveryWatermark("codex")).toBeNull();
    store.setDiscoveryWatermark("codex", "2026-07-19T01:00:00.000Z");
    store.setDiscoveryWatermark("claude-code", "2026-07-19T02:00:00.000Z");

    expect(store.getDiscoveryWatermark("codex")).toBe(
      "2026-07-19T01:00:00.000Z",
    );
    expect(store.getDiscoveryWatermark("claude-code")).toBe(
      "2026-07-19T02:00:00.000Z",
    );
    expect(store.getDiscoveryWatermark("grok-build")).toBeNull();
  });

  it("records a declined backfill and starts every source at the decision time", async () => {
    const store = await createStore();
    const decidedAt = "2026-07-28T02:00:00.000Z";

    store.recordBackfillDecision({
      decision: "declined",
      sessions: 12,
      bytes: 4096,
      decidedAt,
    });

    expect(store.getBackfillState()).toEqual({
      decision: "declined",
      sessions: 12,
      bytes: 4096,
      uploaded: 0,
      decidedAt,
      completedAt: decidedAt,
    });
    expect(store.getDiscoveryWatermark("claude-code")).toBe(decidedAt);
    expect(store.getDiscoveryWatermark("codex")).toBe(decidedAt);
    expect(store.getDiscoveryWatermark("grok-build")).toBe(decidedAt);
  });

  it("keeps accepted backfill incomplete until no retryable uploads remain", async () => {
    const store = await createStore();
    store.recordBackfillDecision({
      decision: "accepted",
      sessions: 3,
      bytes: 2048,
      decidedAt: "2026-07-28T02:00:00.000Z",
    });

    store.recordBackfillUpload({
      uploaded: 2,
      pending: 1,
      recordedAt: "2026-07-28T02:01:00.000Z",
    });
    expect(store.getBackfillState()).toMatchObject({
      uploaded: 2,
      completedAt: null,
    });

    store.recordBackfillUpload({
      uploaded: 1,
      pending: 0,
      recordedAt: "2026-07-28T02:02:00.000Z",
    });
    expect(store.getBackfillState()).toMatchObject({
      uploaded: 3,
      completedAt: "2026-07-28T02:02:00.000Z",
    });
  });

  it("migrates legacy upload state into an account-scoped database once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brainhub-state-migrate-"));
    const legacyPath = join(directory, "state.sqlite");
    const scopedPath = join(directory, "accounts", "account-a", "state.sqlite");
    const secondScopedPath = join(
      directory,
      "accounts",
      "account-b",
      "state.sqlite",
    );
    const legacy = new SqliteStateStore(legacyPath);
    const oldDevice = legacy.getOrCreateDevice("macbook");
    legacy.markPending({
      conversationKey: "legacy-key",
      source: "codex",
      conversationId: "legacy-conversation",
      sourcePath: "/sessions/legacy.jsonl",
      sourceUpdatedAt: "2026-07-26T08:20:00.000Z",
      contentSha256: "c".repeat(64),
    });
    legacy.markUploaded("legacy-key", "drive-file", "2026-07-26T08:25:00.000Z");
    legacy.setDiscoveryWatermark("codex", "2026-07-26T08:27:00.000Z");
    legacy.close();

    const premature = new SqliteStateStore(scopedPath);
    premature.getOrCreateDevice("macbook");
    premature.setDiscoveryWatermark("codex", "2026-07-27T01:36:00.000Z");
    premature.close();

    type MigratingStoreConstructor = new (
      path: string,
      options: { legacyPath: string },
    ) => SqliteStateStore;
    const MigratingStore = SqliteStateStore as MigratingStoreConstructor;
    const migrated = new MigratingStore(scopedPath, { legacyPath });
    try {
      expect(migrated.getOrCreateDevice("macbook").id).toBe(oldDevice.id);
      expect(migrated.getSession("legacy-key")).toMatchObject({
        status: "uploaded",
        driveFileId: "drive-file",
      });
      expect(migrated.getDiscoveryWatermark("codex")).toBe(
        "2026-07-26T08:27:00.000Z",
      );
      migrated.setDiscoveryWatermark("codex", "2026-07-27T02:00:00.000Z");
    } finally {
      migrated.close();
    }

    const secondAccount = new MigratingStore(secondScopedPath, { legacyPath });
    try {
      expect(secondAccount.getSession("legacy-key")).toBeNull();
      expect(secondAccount.getDiscoveryWatermark("codex")).toBeNull();
    } finally {
      secondAccount.close();
    }

    const reopened = new MigratingStore(scopedPath, { legacyPath });
    try {
      expect(reopened.getDiscoveryWatermark("codex")).toBe(
        "2026-07-27T02:00:00.000Z",
      );
    } finally {
      reopened.close();
    }
  });
});
