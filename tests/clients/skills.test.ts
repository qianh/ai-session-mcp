import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import type * as Os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => home.path,
}));
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  home.path = await mkdtemp(join(tmpdir(), "brainhub-skills-"));
  homes.push(home.path);
  vi.resetModules();
  return {
    ...(await import("../../src/clients/skills.js")),
    root: join(home.path, ".codex", "skills"),
  };
}
describe("owned BrainHub skills", () => {
  it("preserves legacy user content on uninstall", async () => {
    const { root, installBrainHubSkills, uninstallBrainHubSkills } =
      await setup();
    const legacy = join(root, "brainHub");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "SKILL.md"), "user skill");
    await installBrainHubSkills("codex");
    await uninstallBrainHubSkills("codex");
    expect(await readFile(join(legacy, "SKILL.md"), "utf8")).toBe("user skill");
  });
  it("installs five directly discoverable names and removes only owned files", async () => {
    const { root, installBrainHubSkills, uninstallBrainHubSkills } =
      await setup();
    await installBrainHubSkills("codex");
    const names = await readdir(root);
    expect(names.sort()).toEqual([
      "brainhub-get-portrait",
      "brainhub-get-session",
      "brainhub-hub-status",
      "brainhub-search-sessions",
      "brainhub-upload-sessions",
    ]);
    for (const name of names)
      expect(await readFile(join(root, name, "SKILL.md"), "utf8")).toContain(
        `name: ${name}`,
      );
    await writeFile(join(root, "brainhub-get-portrait", "notes.md"), "keep");
    await installBrainHubSkills("codex");
    await uninstallBrainHubSkills("codex");
    expect(await readdir(root)).toEqual(["brainhub-get-portrait"]);
    expect(await readdir(join(root, "brainhub-get-portrait"))).toEqual([
      "notes.md",
    ]);
  });
  it("preserves existing collisions and locally edited skills", async () => {
    const { root, installBrainHubSkills, uninstallBrainHubSkills } =
      await setup();
    const collision = join(root, "brainhub-get-portrait");
    await mkdir(collision, { recursive: true });
    await writeFile(join(collision, "SKILL.md"), "existing");
    await installBrainHubSkills("codex");
    const edited = join(root, "brainhub-get-session", "SKILL.md");
    await writeFile(edited, "edited");
    await installBrainHubSkills("codex");
    await uninstallBrainHubSkills("codex");
    expect(await readFile(join(collision, "SKILL.md"), "utf8")).toBe(
      "existing",
    );
    expect(await readFile(edited, "utf8")).toBe("edited");
  });
  it("does not follow a pre-existing skill directory symlink", async () => {
    const { root, installBrainHubSkills, uninstallBrainHubSkills } =
      await setup();
    const outside = join(home.path, "outside");
    await mkdir(outside);
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "brainhub-get-portrait"));
    await installBrainHubSkills("codex");
    await uninstallBrainHubSkills("codex");
    expect(await readdir(outside)).toEqual([]);
  });
});
