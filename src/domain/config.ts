import { join } from "node:path";

import { z } from "zod";

const ScheduleSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    device: z.object({ name: z.string().min(1) }),
    drive: z.object({
      rootFolderId: z.string(),
      rootFolderName: z.string().min(1),
      oauthClientFile: z.string(),
      accountEmail: z.string(),
      accountDisplayName: z.string(),
      accountPermissionId: z.string(),
    }),
    capture: z.object({
      claudePaths: z.array(z.string().min(1)).min(1),
      codexPaths: z.array(z.string().min(1)).min(1),
      grokPaths: z.array(z.string().min(1)).min(1),
      includeSubagents: z.boolean(),
      internalDomains: z.array(z.string().min(1)),
      internalCidrs: z.array(z.string().min(1)),
    }),
    publish: z.object({ fallbackPath: z.string() }),
    upload: z.object({
      batchSize: z.int().positive().max(10_000),
      concurrency: z.int().positive().max(32),
    }),
    search: z.object({
      model: z.string().min(1),
      modelRevision: z.string().min(1),
      dimensions: z.int().positive(),
      chunkTokens: z.int().positive().max(512),
      chunkOverlap: z.int().nonnegative(),
      defaultLimit: z.int().positive(),
      maxLimit: z.int().positive().max(50),
    }),
    scheduler: z.object({ at: ScheduleSchema }),
  })
  .superRefine((config, context) => {
    if (config.search.defaultLimit > config.search.maxLimit) {
      context.addIssue({
        code: "custom",
        message: "defaultLimit must not exceed maxLimit",
        path: ["search", "defaultLimit"],
      });
    }
    if (config.search.chunkOverlap >= config.search.chunkTokens) {
      context.addIssue({
        code: "custom",
        message: "chunkOverlap must be smaller than chunkTokens",
        path: ["search", "chunkOverlap"],
      });
    }
  });

export type BrainHubConfig = z.infer<typeof ConfigSchema>;

export interface PlatformPathOptions {
  platform: NodeJS.Platform;
  homeDir: string;
  xdgConfigHome?: string;
  xdgStateHome?: string;
  xdgCacheHome?: string;
}

export interface PlatformPaths {
  configFile: string;
  stateFile: string;
  modelCache: string;
}

export function platformPaths(options: PlatformPathOptions): PlatformPaths {
  if (options.platform === "darwin") {
    const applicationSupport = join(
      options.homeDir,
      "Library",
      "Application Support",
      "BrainHub",
    );
    return {
      configFile: join(applicationSupport, "config.toml"),
      stateFile: join(applicationSupport, "state.sqlite"),
      modelCache: join(
        options.homeDir,
        "Library",
        "Caches",
        "BrainHub",
        "models",
      ),
    };
  }

  return {
    configFile: join(
      options.xdgConfigHome ?? join(options.homeDir, ".config"),
      "brain-mcp",
      "config.toml",
    ),
    stateFile: join(
      options.xdgStateHome ?? join(options.homeDir, ".local", "state"),
      "brain-mcp",
      "state.sqlite",
    ),
    modelCache: join(
      options.xdgCacheHome ?? join(options.homeDir, ".cache"),
      "brain-mcp",
      "models",
    ),
  };
}

export function createDefaultConfig(options: {
  hostname: string;
  homeDir: string;
  platform: NodeJS.Platform;
}): BrainHubConfig {
  return ConfigSchema.parse({
    version: 1,
    device: { name: options.hostname },
    drive: {
      rootFolderId: "",
      rootFolderName: "brain-hub",
      oauthClientFile: "",
      accountEmail: "",
      accountDisplayName: "",
      accountPermissionId: "",
    },
    capture: {
      claudePaths: [join(options.homeDir, ".claude", "projects")],
      codexPaths: [join(options.homeDir, ".codex", "sessions")],
      grokPaths: [join(options.homeDir, ".grok", "sessions")],
      includeSubagents: false,
      internalDomains: [],
      internalCidrs: [],
    },
    publish: { fallbackPath: "" },
    upload: { batchSize: 100, concurrency: 4 },
    search: {
      model: "Xenova/multilingual-e5-small",
      modelRevision: "ae61bf0193ce3851dc8a45147e459b04ed783d8a",
      dimensions: 384,
      chunkTokens: 448,
      chunkOverlap: 64,
      defaultLimit: 10,
      maxLimit: 50,
    },
    scheduler: { at: "02:00" },
  });
}

type DeepPartial<T> = T extends readonly (infer Item)[]
  ? DeepPartial<Item>[]
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> }
    : T;

export type ConfigLayer = DeepPartial<BrainHubConfig>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch as T;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(value)
        ? deepMerge(current, value)
        : value;
  }
  return merged as T;
}

export function mergeConfigLayers(
  defaults: BrainHubConfig,
  layers: { file?: ConfigLayer; env?: ConfigLayer; cli?: ConfigLayer },
): BrainHubConfig {
  const merged = [layers.file, layers.env, layers.cli].reduce(
    (config, layer) => (layer ? deepMerge(config, layer) : config),
    defaults,
  );
  return ConfigSchema.parse(merged);
}
