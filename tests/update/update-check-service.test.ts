import { describe, expect, it, vi } from "vitest";

import { UpdateCheckService } from "../../src/update/update-check-service.js";

describe("manual update checks", () => {
  it("reuses a successful npm result for 24 hours", async () => {
    const read = vi.fn(async () => ({
      checkedAt: "2026-07-26T00:00:00.000Z",
      latestVersion: "0.2.0",
    }));
    const fetchLatest = vi.fn(async () => "0.3.0");
    const service = new UpdateCheckService({
      currentVersion: "0.1.0",
      now: () => new Date("2026-07-26T12:00:00.000Z"),
      cache: { read, write: vi.fn(async () => undefined) },
      fetchLatest,
    });

    await expect(service.check()).resolves.toMatchObject({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
      source: "cache",
    });
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("refreshes an expired result and caches it", async () => {
    const write = vi.fn(async () => undefined);
    const fetchLatest = vi.fn(async () => "0.1.0");
    const service = new UpdateCheckService({
      currentVersion: "0.1.0",
      now: () => new Date("2026-07-27T00:00:01.000Z"),
      cache: {
        read: async () => ({
          checkedAt: "2026-07-26T00:00:00.000Z",
          latestVersion: "0.0.9",
        }),
        write,
      },
      fetchLatest,
    });

    await expect(service.check()).resolves.toMatchObject({
      latestVersion: "0.1.0",
      updateAvailable: false,
      source: "network",
    });
    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith({
      checkedAt: "2026-07-27T00:00:01.000Z",
      latestVersion: "0.1.0",
    });
  });

  it("keeps status available when npm cannot be reached", async () => {
    const service = new UpdateCheckService({
      currentVersion: "0.1.0",
      now: () => new Date("2026-07-27T00:00:01.000Z"),
      cache: {
        read: async () => null,
        write: async () => undefined,
      },
      fetchLatest: async () => {
        throw new Error("offline");
      },
    });

    await expect(service.check()).resolves.toEqual({
      currentVersion: "0.1.0",
      updateAvailable: false,
      source: "unavailable",
      warning: "UPDATE_CHECK_FAILED",
    });
  });
});
