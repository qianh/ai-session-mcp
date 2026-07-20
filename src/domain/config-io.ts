import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, join, resolve } from "node:path";

import TOML from "@iarna/toml";

import {
  createDefaultConfig,
  mergeConfigLayers,
  platformPaths,
  type BrainHubConfig,
  type ConfigLayer,
  type PlatformPaths,
} from "./config.js";

function camelKey(value: string): string {
  return value.replace(/_([a-z])/gu, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

function snakeKey(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

function mapKeys(value: unknown, keyMapper: (key: string) => string): unknown {
  if (Array.isArray(value))
    return value.map((item) => mapKeys(item, keyMapper));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      keyMapper(key),
      mapKeys(child, keyMapper),
    ]),
  );
}

function booleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  return undefined;
}

function numberEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, compact(child)]),
  );
}

function environmentLayer(env: NodeJS.ProcessEnv): ConfigLayer {
  return compact({
    device: { name: env.BRAINHUB_DEVICE_NAME },
    drive: {
      rootFolderId: env.BRAINHUB_DRIVE_ROOT_ID,
      oauthClientFile: env.BRAINHUB_GOOGLE_OAUTH_CLIENT_FILE,
    },
    capture: {
      claudePaths: env.BRAINHUB_CLAUDE_PATHS?.split(delimiter),
      codexPaths: env.BRAINHUB_CODEX_PATHS?.split(delimiter),
      grokPaths: env.BRAINHUB_GROK_PATHS?.split(delimiter),
      includeSubagents: booleanEnv(env.BRAINHUB_INCLUDE_SUBAGENTS),
    },
    publish: { fallbackPath: env.BRAINHUB_PUBLISH_FALLBACK_PATH },
    upload: {
      batchSize: numberEnv(env.BRAINHUB_UPLOAD_BATCH_SIZE),
      concurrency: numberEnv(env.BRAINHUB_UPLOAD_CONCURRENCY),
    },
    scheduler: { at: env.BRAINHUB_SCHEDULE_AT },
  }) as ConfigLayer;
}

function expandHome(value: string, homeDir: string): string {
  return value === "~"
    ? homeDir
    : value.startsWith("~/")
      ? join(homeDir, value.slice(2))
      : value;
}

export interface LoadedConfig {
  config: BrainHubConfig;
  paths: PlatformPaths;
  configFile: string;
}

async function resolveConfigWritePath(
  path: string,
  visited = new Set<string>(),
): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
  if (!metadata.isSymbolicLink()) return path;
  const identity = resolve(path);
  if (visited.has(identity)) throw new Error("Config symlink cycle detected");
  visited.add(identity);
  const target = await readlink(path);
  return resolveConfigWritePath(resolve(dirname(path), target), visited);
}

export async function loadConfig(options: {
  homeDir: string;
  hostname: string;
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  configFile?: string;
  cli?: ConfigLayer;
}): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const basePaths = platformPaths({
    platform: options.platform,
    homeDir: options.homeDir,
    ...(env.XDG_CONFIG_HOME ? { xdgConfigHome: env.XDG_CONFIG_HOME } : {}),
    ...(env.XDG_STATE_HOME ? { xdgStateHome: env.XDG_STATE_HOME } : {}),
    ...(env.XDG_CACHE_HOME ? { xdgCacheHome: env.XDG_CACHE_HOME } : {}),
  });
  const configFile =
    options.configFile ?? env.BRAINHUB_CONFIG ?? basePaths.configFile;
  let file: ConfigLayer | undefined;
  try {
    file = mapKeys(
      TOML.parse(await readFile(configFile, "utf8")),
      camelKey,
    ) as ConfigLayer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = mergeConfigLayers(
    createDefaultConfig({
      hostname: options.hostname,
      homeDir: options.homeDir,
      platform: options.platform,
    }),
    {
      ...(file ? { file } : {}),
      env: environmentLayer(env),
      ...(options.cli ? { cli: options.cli } : {}),
    },
  );
  config.capture.claudePaths = config.capture.claudePaths.map((path) =>
    expandHome(path, options.homeDir),
  );
  config.capture.codexPaths = config.capture.codexPaths.map((path) =>
    expandHome(path, options.homeDir),
  );
  config.capture.grokPaths = config.capture.grokPaths.map((path) =>
    expandHome(path, options.homeDir),
  );
  config.drive.oauthClientFile = expandHome(
    config.drive.oauthClientFile,
    options.homeDir,
  );
  config.publish.fallbackPath = expandHome(
    config.publish.fallbackPath,
    options.homeDir,
  );
  return {
    config,
    configFile,
    paths: {
      ...basePaths,
      ...(env.BRAINHUB_MODEL_CACHE
        ? { modelCache: expandHome(env.BRAINHUB_MODEL_CACHE, options.homeDir) }
        : {}),
    },
  };
}

export async function writeConfig(
  path: string,
  config: BrainHubConfig,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const writePath = await resolveConfigWritePath(path);
  await mkdir(dirname(writePath), { recursive: true });
  const serializable = mapKeys(config, snakeKey) as TOML.JsonMap;
  const temporaryPath = `${writePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, TOML.stringify(serializable), {
      mode: 0o600,
    });
    await rename(temporaryPath, writePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
