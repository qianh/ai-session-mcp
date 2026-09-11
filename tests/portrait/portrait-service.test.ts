import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { PortraitService } from "../../src/portrait/portrait-service.js";

describe("portrait reading", () => {
  it("reads the full Digital Twin file without local side effects", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "brainhub-home-"));
    const drive = new MemoryDrive();
    await drive.put({
      path: "Digital_Twin_Profile.md",
      bytes: Buffer.from("# Authoritative Digital Twin\n"),
      mimeType: "text/markdown",
    });
    const service = new PortraitService({ drive });

    await expect(service.getPortrait()).resolves.toEqual({
      portrait: "# Authoritative Digital Twin\n",
    });
    await expect(
      readFile(join(homeDir, "BrainHub", "portrait.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a missing Digital Twin file explicitly", async () => {
    const service = new PortraitService({ drive: new MemoryDrive() });

    await expect(service.getPortrait()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      retryable: false,
    });
  });

  it("reads a configured Drive directory and file", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "profiles/custom.md",
      bytes: Buffer.from("custom"),
      mimeType: "text/markdown",
    });
    const service = new PortraitService({ drive, path: "profiles/custom.md" });
    await expect(service.getPortrait()).resolves.toEqual({
      portrait: "custom",
    });
  });
});
