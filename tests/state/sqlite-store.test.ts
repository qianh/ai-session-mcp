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
});
