import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

interface ObsidianVault {
  path?: unknown;
  ts?: unknown;
  open?: unknown;
}

export interface PublishDiscoveryOptions {
  platform: NodeJS.Platform;
  homeDir: string;
  fallbackPath: string;
  xdgConfigHome?: string;
}

async function ensureWritable(path: string): Promise<string | null> {
  try {
    await mkdir(path, { recursive: true });
    await access(path, constants.W_OK);
    return path;
  } catch {
    return null;
  }
}

function decodeVaultPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function discoverPublishDirectory(
  options: PublishDiscoveryOptions,
): Promise<string | null> {
  const configPath =
    options.platform === "darwin"
      ? join(
          options.homeDir,
          "Library",
          "Application Support",
          "obsidian",
          "obsidian.json",
        )
      : join(
          options.xdgConfigHome ?? join(options.homeDir, ".config"),
          "obsidian",
          "obsidian.json",
        );
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      vaults?: Record<string, ObsidianVault>;
    };
    const vaults = Object.values(config.vaults ?? {})
      .filter(
        (vault): vault is ObsidianVault & { path: string } =>
          typeof vault.path === "string",
      )
      .sort((left, right) => {
        const open = Number(right.open === true) - Number(left.open === true);
        return open || Number(right.ts ?? 0) - Number(left.ts ?? 0);
      });
    for (const vault of vaults) {
      const directory = await ensureWritable(
        join(decodeVaultPath(vault.path), "BrainHub"),
      );
      if (directory) return directory;
    }
  } catch {
    // Obsidian is optional; the explicit fallback is checked below.
  }

  return options.fallbackPath ? ensureWritable(options.fallbackPath) : null;
}
