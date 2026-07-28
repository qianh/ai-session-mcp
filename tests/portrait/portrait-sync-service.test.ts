import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { PortraitSyncService } from "../../src/portrait/portrait-sync-service.js";

describe("daily portrait sync", () => {
  it("atomically overwrites only the fixed Obsidian portrait path", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "brainhub-home-"));
    const vault = join(homeDir, "Notes");
    const targetDirectory = join(vault, "BrainHub");
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(targetDirectory, "portrait.md"), "# Previous\n");
    const drive = new MemoryDrive();
    await drive.put({
      path: "Digital_Twin_Profile.md",
      bytes: Buffer.from("# Current Digital Twin\n"),
      mimeType: "text/markdown",
    });
    const service = new PortraitSyncService({
      portraitSource: { drive, path: "Digital_Twin_Profile.md" },
      publish: {
        platform: "darwin",
        homeDir,
        fallbackPath: targetDirectory,
      },
    });

    const result = await service.sync();

    expect(result).toEqual({
      synced: true,
      path: join(targetDirectory, "portrait.md"),
      warnings: [],
    });
    await expect(
      readFile(join(targetDirectory, "portrait.md"), "utf8"),
    ).resolves.toBe("# Current Digital Twin\n");
    await expect(
      readFile(join(targetDirectory, "weekly-latest.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not fail setup when Obsidian is not configured", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "brainhub-home-"));
    const drive = new MemoryDrive();
    await drive.put({
      path: "Digital_Twin_Profile.md",
      bytes: Buffer.from("# Digital Twin\n"),
      mimeType: "text/markdown",
    });
    const service = new PortraitSyncService({
      portraitSource: { drive, path: "Digital_Twin_Profile.md" },
      publish: { platform: "darwin", homeDir, fallbackPath: "" },
    });

    await expect(service.sync()).resolves.toEqual({
      synced: false,
      warnings: [expect.objectContaining({ code: "PUBLISH_PATH_REQUIRED" })],
    });
  });
});
