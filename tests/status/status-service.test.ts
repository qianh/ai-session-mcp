import { describe, expect, it } from "vitest";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { StatusService } from "../../src/status/status-service.js";

describe("hub status", () => {
  it("returns only the supported account, data, and local component status", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/a.md",
      bytes: Buffer.from("a"),
      mimeType: "text/markdown",
    });
    const service = new StatusService({
      account: { connected: true, email: "person@example.com" },
      root: { configured: true, id: "root-1", name: "brain-hub" },
      drive,
      upload: async () => ({ codex: { discovered: 1 } }),
      model: async () => ({ ready: true, bytes: 1024 }),
      index: async () => ({ ready: true, documents: 1, cursor: "10" }),
      launchd: async () => ({ installed: true }),
      portrait: async () => ({ available: true }),
      obsidian: async () => ({ configured: false }),
      update: async () => ({
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        updateAvailable: true,
      }),
    });

    const result = await service.getStatus();

    expect(result).toMatchObject({
      account: { connected: true, email: "person@example.com" },
      root: { configured: true, id: "root-1", name: "brain-hub" },
      upload: { inbox: { mac: 1 }, adapters: { codex: { discovered: 1 } } },
      model: { ready: true, bytes: 1024 },
      index: { ready: true, documents: 1, cursor: "10" },
      launchd: { installed: true },
      portrait: { available: true },
      obsidian: { configured: false },
      update: {
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        updateAvailable: true,
      },
    });
    expect(result).not.toHaveProperty("distill");
    expect(result).not.toHaveProperty("weekly");
    expect(result).not.toHaveProperty("capacity");
  });

  it("keeps local component status when Drive is unavailable", async () => {
    const service = new StatusService({
      account: { connected: false },
      root: { configured: false, name: "brain-hub" },
      drive: async () => {
        throw new Error("Drive is not configured");
      },
      upload: async () => ({ codex: { discovered: 1 } }),
      model: async () => ({ ready: false, bytes: 0 }),
      index: async () => ({ ready: false, documents: 0 }),
      launchd: async () => ({ installed: false }),
      portrait: async () => ({ available: false }),
      obsidian: async () => ({ configured: false }),
      update: async () => ({
        currentVersion: "0.1.0",
        updateAvailable: false,
      }),
    });

    const result = await service.getStatus();

    expect(result.upload).toMatchObject({
      driveReachable: false,
      inbox: {},
      adapters: { codex: { discovered: 1 } },
    });
    expect(result.model).toEqual({ ready: false, bytes: 0 });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "DRIVE_UNAVAILABLE" }),
    );
  });
});
