import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverPublishDirectory } from "../../src/portrait/obsidian.js";

describe("Obsidian portrait target", () => {
  it("uses only the vault explicitly selected during setup", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "brainhub-obsidian-"));
    const activeVault = join(homeDir, "Active");
    const selected = join(homeDir, "Selected", "BrainHub");
    const configDirectory = join(
      homeDir,
      "Library",
      "Application Support",
      "obsidian",
    );
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "obsidian.json"),
      JSON.stringify({ vaults: { active: { path: activeVault, open: true } } }),
    );

    await expect(
      discoverPublishDirectory({
        platform: "darwin",
        homeDir,
        fallbackPath: selected,
      }),
    ).resolves.toBe(selected);
    await expect(
      discoverPublishDirectory({
        platform: "darwin",
        homeDir,
        fallbackPath: "",
      }),
    ).resolves.toBeNull();
  });
});
