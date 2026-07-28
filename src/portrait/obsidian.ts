import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";

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

export async function discoverPublishDirectory(
  options: PublishDiscoveryOptions,
): Promise<string | null> {
  return options.fallbackPath ? ensureWritable(options.fallbackPath) : null;
}
