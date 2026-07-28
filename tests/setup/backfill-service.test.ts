import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BackfillService } from "../../src/setup/backfill-service.js";
import { SqliteStateStore } from "../../src/state/sqlite-store.js";

const stores: SqliteStateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function stateStore(): Promise<SqliteStateStore> {
  const directory = await mkdtemp(join(tmpdir(), "brainhub-backfill-"));
  const store = new SqliteStateStore(join(directory, "state.sqlite"));
  stores.push(store);
  return store;
}

describe("first backfill workflow", () => {
  it("returns a completed decision without inspecting or prompting again", async () => {
    const state = await stateStore();
    const inspect = vi.fn(async () => ({ sessions: 3, bytes: 2048 }));
    const confirm = vi.fn(async () => true);
    const upload = vi.fn(async () => ({ uploaded: 3, pending: 0 }));
    const service = new BackfillService({
      state,
      inspect,
      confirm,
      upload,
      report: () => undefined,
      now: () => "2026-07-28T02:00:00.000Z",
    });

    const first = await service.run();
    const second = await service.run();

    expect(first).toEqual({
      sessions: 3,
      bytes: 2048,
      confirmed: true,
      uploaded: 3,
      completed: true,
    });
    expect(second).toEqual(first);
    expect(inspect).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
  });

  it("retries pending uploads without repeating inspection or confirmation", async () => {
    const state = await stateStore();
    const inspect = vi.fn(async () => ({ sessions: 3, bytes: 2048 }));
    const confirm = vi.fn(async () => true);
    const upload = vi
      .fn<() => Promise<{ uploaded: number; pending: number }>>()
      .mockResolvedValueOnce({ uploaded: 2, pending: 1 })
      .mockResolvedValueOnce({ uploaded: 1, pending: 0 });
    const service = new BackfillService({
      state,
      inspect,
      confirm,
      upload,
      report: () => undefined,
      now: () => "2026-07-28T02:00:00.000Z",
    });

    await expect(service.run()).resolves.toMatchObject({
      uploaded: 2,
      completed: false,
    });
    await expect(service.run()).resolves.toMatchObject({
      uploaded: 3,
      completed: true,
    });
    expect(inspect).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("retains acceptance when upload throws and retries without prompting", async () => {
    const state = await stateStore();
    const inspect = vi.fn(async () => ({ sessions: 1, bytes: 512 }));
    const confirm = vi.fn(async () => true);
    const upload = vi
      .fn<() => Promise<{ uploaded: number; pending: number }>>()
      .mockRejectedValueOnce(new Error("Drive offline"))
      .mockResolvedValueOnce({ uploaded: 1, pending: 0 });
    const service = new BackfillService({
      state,
      inspect,
      confirm,
      upload,
      report: () => undefined,
      now: () => "2026-07-28T02:00:00.000Z",
    });

    await expect(service.run()).rejects.toThrow(/Drive offline/);
    await expect(service.run()).resolves.toMatchObject({
      confirmed: true,
      uploaded: 1,
      completed: true,
    });
    expect(inspect).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("persists a decline and never inspects or prompts again", async () => {
    const state = await stateStore();
    const inspect = vi.fn(async () => ({ sessions: 4, bytes: 1024 }));
    const confirm = vi.fn(async () => false);
    const upload = vi.fn(async () => ({ uploaded: 0, pending: 0 }));
    const service = new BackfillService({
      state,
      inspect,
      confirm,
      upload,
      report: () => undefined,
      now: () => "2026-07-28T02:00:00.000Z",
    });

    const first = await service.run();
    const second = await service.run();

    expect(first).toMatchObject({
      confirmed: false,
      uploaded: 0,
      completed: true,
    });
    expect(second).toEqual(first);
    expect(inspect).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
  });
});
