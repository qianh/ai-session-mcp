import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCacheRecord {
  checkedAt: string;
  latestVersion: string;
}

export interface UpdateCache {
  read(): Promise<UpdateCacheRecord | null>;
  write(record: UpdateCacheRecord): Promise<void>;
}

interface UpdateCheckDependencies {
  currentVersion: string;
  cache: UpdateCache;
  fetchLatest(): Promise<string>;
  now?: () => Date;
}

function versionParts(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(candidate: string, current: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}

function output(
  currentVersion: string,
  latestVersion: string,
  source: "cache" | "network",
  checkedAt: string,
) {
  return {
    currentVersion,
    latestVersion,
    updateAvailable: isNewer(latestVersion, currentVersion),
    source,
    checkedAt,
  };
}

export class UpdateCheckService {
  constructor(readonly dependencies: UpdateCheckDependencies) {}

  async check() {
    const now = (this.dependencies.now ?? (() => new Date()))();
    const cached = await this.dependencies.cache.read().catch(() => null);
    if (
      cached &&
      now.getTime() - new Date(cached.checkedAt).getTime() < CHECK_INTERVAL_MS
    ) {
      return output(
        this.dependencies.currentVersion,
        cached.latestVersion,
        "cache",
        cached.checkedAt,
      );
    }
    try {
      const latestVersion = await this.dependencies.fetchLatest();
      if (!versionParts(latestVersion)) throw new Error("Invalid npm version");
      const record = { checkedAt: now.toISOString(), latestVersion };
      await this.dependencies.cache.write(record);
      return output(
        this.dependencies.currentVersion,
        latestVersion,
        "network",
        record.checkedAt,
      );
    } catch {
      return {
        currentVersion: this.dependencies.currentVersion,
        updateAvailable: false,
        source: "unavailable" as const,
        warning: "UPDATE_CHECK_FAILED",
      };
    }
  }
}

export class FileUpdateCache implements UpdateCache {
  constructor(readonly path: string) {}

  async read(): Promise<UpdateCacheRecord | null> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as {
        checkedAt?: unknown;
        latestVersion?: unknown;
      };
      return typeof value.checkedAt === "string" &&
        typeof value.latestVersion === "string"
        ? {
            checkedAt: value.checkedAt,
            latestVersion: value.latestVersion,
          }
        : null;
    } catch {
      return null;
    }
  }

  async write(record: UpdateCacheRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

export async function fetchNpmLatestVersion(): Promise<string> {
  const response = await fetch(
    "https://registry.npmjs.org/brainhub-mcp/latest",
    {
      signal: AbortSignal.timeout(3_000),
    },
  );
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const payload = (await response.json()) as { version?: unknown };
  if (typeof payload.version !== "string") {
    throw new Error("npm registry response has no version");
  }
  return payload.version;
}
