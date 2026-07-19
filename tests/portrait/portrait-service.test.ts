import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { discoverPublishDirectory } from "../../src/portrait/obsidian.js";
import { PortraitService } from "../../src/portrait/portrait-service.js";

describe("portrait publishing", () => {
  it("prefers the active Obsidian vault over the configured fallback", async () => {
    const home = await mkdtemp(join(tmpdir(), "brainhub-home-"));
    const vault = join(home, "Notes");
    const fallback = join(home, "fallback");
    await Promise.all([mkdir(vault), mkdir(fallback)]);
    const configDirectory = join(
      home,
      "Library",
      "Application Support",
      "obsidian",
    );
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "obsidian.json"),
      JSON.stringify({ vaults: { abc: { path: vault, ts: 20, open: true } } }),
    );

    await expect(
      discoverPublishDirectory({
        platform: "darwin",
        homeDir: home,
        fallbackPath: fallback,
      }),
    ).resolves.toBe(join(vault, "BrainHub"));
  });

  it("falls back to an explicit writable directory and writes both documents", async () => {
    const home = await mkdtemp(join(tmpdir(), "brainhub-home-"));
    const fallback = join(home, "publish");
    const drive = new MemoryDrive();
    await drive.put({
      path: "publish/portrait.md",
      bytes: Buffer.from("# Portrait\n\n## 变更 Diff\n- Changed focus\n"),
      mimeType: "text/markdown",
    });
    await drive.put({
      path: "publish/weekly-latest.md",
      bytes: Buffer.from("# Weekly\n"),
      mimeType: "text/markdown",
    });
    const service = new PortraitService({
      drive,
      publish: { platform: "linux", homeDir: home, fallbackPath: fallback },
    });

    const result = await service.pullPortrait();

    expect(result).toMatchObject({
      localRefreshed: true,
      weeklyRefreshed: true,
    });
    expect(result.diff).toContain("Changed focus");
    expect(await readFile(join(fallback, "portrait.md"), "utf8")).toContain(
      "# Portrait",
    );
    expect(
      await readFile(join(fallback, "weekly-latest.md"), "utf8"),
    ).toContain("# Weekly");
  });

  it("returns Drive portrait with a warning when no writable destination exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "brainhub-home-"));
    const drive = new MemoryDrive();
    await drive.put({
      path: "publish/portrait.md",
      bytes: Buffer.from("portrait"),
      mimeType: "text/markdown",
    });
    const service = new PortraitService({
      drive,
      publish: { platform: "linux", homeDir: home, fallbackPath: "" },
    });
    const result = await service.getPortrait();
    expect(result).toMatchObject({
      portrait: "portrait",
      localRefreshed: false,
    });
    expect(result.warnings[0]?.code).toBe("PUBLISH_PATH_REQUIRED");
  });

  it("extracts every line in the Diff section", async () => {
    const home = await mkdtemp(join(tmpdir(), "brainhub-home-"));
    const fallback = join(home, "publish");
    const drive = new MemoryDrive();
    await drive.put({
      path: "publish/portrait.md",
      bytes: Buffer.from(
        "# Portrait\n\n## Diff\n- First change\n- Second change\n\n## Details\nUnrelated\n",
      ),
      mimeType: "text/markdown",
    });
    const service = new PortraitService({
      drive,
      publish: { platform: "linux", homeDir: home, fallbackPath: fallback },
    });

    const result = await service.getPortrait();

    expect(result.diff).toBe("- First change\n- Second change");
  });

  it("preserves the previous portrait when the document pair cannot commit", async () => {
    const home = await mkdtemp(join(tmpdir(), "brainhub-home-"));
    const fallback = join(home, "publish");
    await mkdir(fallback, { recursive: true });
    await writeFile(join(fallback, "portrait.md"), "# Previous portrait\n");
    await mkdir(join(fallback, "weekly-latest.md"));
    const drive = new MemoryDrive();
    await drive.put({
      path: "publish/portrait.md",
      bytes: Buffer.from("# New portrait\n"),
      mimeType: "text/markdown",
    });
    await drive.put({
      path: "publish/weekly-latest.md",
      bytes: Buffer.from("# New weekly\n"),
      mimeType: "text/markdown",
    });
    const service = new PortraitService({
      drive,
      publish: { platform: "linux", homeDir: home, fallbackPath: fallback },
    });

    const result = await service.pullPortrait();

    expect(result).toMatchObject({
      localRefreshed: false,
      weeklyRefreshed: false,
    });
    expect(await readFile(join(fallback, "portrait.md"), "utf8")).toBe(
      "# Previous portrait\n",
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "PUBLISH_WRITE_FAILED" }),
    );
  });

  it("does not refresh either local document when Drive has no weekly report", async () => {
    const home = await mkdtemp(join(tmpdir(), "brainhub-home-"));
    const fallback = join(home, "publish");
    await mkdir(fallback, { recursive: true });
    await writeFile(join(fallback, "portrait.md"), "# Previous portrait\n");
    const drive = new MemoryDrive();
    await drive.put({
      path: "publish/portrait.md",
      bytes: Buffer.from("# New portrait\n"),
      mimeType: "text/markdown",
    });
    const service = new PortraitService({
      drive,
      publish: { platform: "linux", homeDir: home, fallbackPath: fallback },
    });

    const result = await service.pullPortrait();

    expect(result).toMatchObject({
      localRefreshed: false,
      weeklyRefreshed: false,
    });
    expect(await readFile(join(fallback, "portrait.md"), "utf8")).toBe(
      "# Previous portrait\n",
    );
  });
});
