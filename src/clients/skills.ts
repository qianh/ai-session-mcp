import { homedir } from "node:os";
import {
  lstat,
  mkdir,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ClientName } from "./registry.js";

const tools = [
  "get_portrait",
  "search_sessions",
  "get_session",
  "upload_sessions",
  "hub_status",
] as const;
const markerName = ".brainhub-owned.json";

function root(client: ClientName, homeDir: string): string {
  return join(homeDir, `.${client}`, "skills");
}

function skillName(tool: string): string {
  return `brainhub-${tool.replaceAll("_", "-")}`;
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function installBrainHubSkills(
  client: ClientName,
  homeDir = homedir(),
): Promise<void> {
  await mkdir(root(client, homeDir), { recursive: true });
  for (const tool of tools) {
    const name = skillName(tool);
    const dir = join(root(client, homeDir), name);
    // Claim only a newly created directory; never overwrite an existing skill.
    try {
      await mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const content = `---\nname: ${name}\ndescription: 调用 BrainHub 的 ${tool} MCP 方法。\n---\n\n调用 MCP 工具 mcp__brain_hub__${tool}。用户明确要求该操作时，按该工具的参数定义提取参数并执行。\n`;
    await writeFile(join(dir, "SKILL.md"), content, { flag: "wx" });
    await writeFile(
      join(dir, markerName),
      JSON.stringify({ owner: "brainhub-mcp", content }),
      { flag: "wx" },
    );
  }
}

export async function uninstallBrainHubSkills(
  client: ClientName,
  homeDir = homedir(),
): Promise<void> {
  for (const tool of tools) {
    const dir = join(root(client, homeDir), skillName(tool));
    if (!(await statIfPresent(dir))?.isDirectory()) continue;
    const file = join(dir, "SKILL.md");
    const marker = join(dir, markerName);
    if (!(await statIfPresent(marker))?.isFile()) continue;
    let ownership: { owner?: unknown; content?: unknown };
    try {
      ownership = JSON.parse(
        await readFile(marker, "utf8"),
      ) as typeof ownership;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (
      !ownership ||
      ownership.owner !== "brainhub-mcp" ||
      typeof ownership.content !== "string"
    )
      continue;
    const stat = await statIfPresent(file);
    if (stat) {
      if (
        !stat.isFile() ||
        (await readFile(file, "utf8")) !== ownership.content
      )
        continue;
      await unlink(file);
    }
    await unlink(marker);
    try {
      await rmdir(dir);
    } catch (error) {
      if (
        !["ENOTEMPTY", "EEXIST", "ENOENT"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
}
