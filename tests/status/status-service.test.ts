import { describe, expect, it } from "vitest";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { StatusService } from "../../src/status/status-service.js";

describe("hub status", () => {
  it("aggregates live quota, inbox, distill, and last valid capacity", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/a.md",
      bytes: Buffer.from("a"),
      mimeType: "text/markdown",
    });
    await drive.put({
      path: "inbox/linux/b.md",
      bytes: Buffer.from("bb"),
      mimeType: "text/markdown",
    });
    await drive.put({
      path: "_meta/distill-status.json",
      bytes: Buffer.from(
        JSON.stringify({ schema_version: 1, daily: { status: "success" } }),
      ),
      mimeType: "application/json",
    });
    await drive.put({
      path: "_meta/capacity.jsonl",
      bytes: Buffer.from(
        '{"schema_version":1,"timestamp":"2026-07-18T00:00:00.000Z","used_bytes":3}\ninvalid\n',
      ),
      mimeType: "application/jsonl",
    });
    const service = new StatusService({
      drive,
      adapters: async () => ({ codex: { available: true } }),
      scheduler: async () => ({ installed: false }),
    });

    const result = await service.getStatus();
    expect(result.drive).toMatchObject({ reachable: true });
    expect(result.inbox).toEqual({ linux: 1, mac: 1 });
    expect(result.distill).toMatchObject({ schema_version: 1 });
    expect(result.capacity).toMatchObject({ used_bytes: 3 });
    expect(result.adapters).toMatchObject({ codex: { available: true } });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "MALFORMED_CAPACITY_LINE" }),
    );
  });

  it("returns local status when Drive initialization fails", async () => {
    const service = new StatusService({
      drive: async () => {
        throw new Error("Drive is not configured");
      },
      adapters: async () => ({ codex: { available: true } }),
      scheduler: async () => ({ installed: false }),
    });

    const result = await service.getStatus();

    expect(result.drive).toEqual({ reachable: false });
    expect(result.adapters).toEqual({ codex: { available: true } });
    expect(result.scheduler).toEqual({ installed: false });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "DRIVE_UNAVAILABLE" }),
    );
  });
});
