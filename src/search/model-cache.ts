import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ModelIdentity {
  model: string;
  revision: string;
  dimensions: number;
}

interface ModelCompletion extends ModelIdentity {
  version: 1;
}

function completion(identity: ModelIdentity): ModelCompletion {
  return { version: 1, ...identity };
}

function markerPath(cacheDir: string, identity: ModelIdentity): string {
  const key = createHash("sha256")
    .update(JSON.stringify(completion(identity)))
    .digest("hex")
    .slice(0, 24);
  return join(cacheDir, `.brainhub-ready-${key}.json`);
}

export async function markModelReady(
  cacheDir: string,
  identity: ModelIdentity,
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const path = markerPath(cacheDir, identity);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(completion(identity)), {
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function isModelReady(
  cacheDir: string,
  identity: ModelIdentity,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(
      await readFile(markerPath(cacheDir, identity), "utf8"),
    ) as unknown;
    return JSON.stringify(parsed) === JSON.stringify(completion(identity));
  } catch {
    return false;
  }
}
