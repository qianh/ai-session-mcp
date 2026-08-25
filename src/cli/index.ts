#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { google, type drive_v3 } from "googleapis";

import {
  resolveGoogleAccountStatus,
  resolveReusableGoogleAccount,
} from "../auth/account-status.js";
import {
  applyGoogleConnection,
  clearGoogleConnection,
  connectGoogleAccount,
  readGoogleDriveAccount,
} from "../auth/google-account.js";
import {
  GoogleOAuth,
  revokeGoogleCredential,
  type GoogleOAuthClient,
} from "../auth/google-oauth.js";
import {
  createConfigSecretStore,
  type ConfigSecretStoreFactory,
} from "../auth/secret-store-factory.js";
import type { SecretStore } from "../auth/secret-store.js";
import {
  ClientRegistry,
  launchWithConfig,
  mergeClaudeDesktopConfig,
  type ClientName,
} from "../clients/registry.js";
import {
  loadConfig,
  writeConfig,
  type LoadedConfig,
} from "../domain/config-io.js";
import { BrainHubError } from "../domain/errors.js";
import { SESSION_SOURCES, type SessionSource } from "../domain/session.js";
import { serveMcp } from "../mcp/server.js";
import { BrainHubRuntime } from "../runtime/container.js";
import { SchedulerManager } from "../scheduler/manager.js";
import { E5Embedder } from "../search/e5-embedder.js";
import {
  BackfillService,
  type BackfillResult,
} from "../setup/backfill-service.js";
import { SetupService } from "../setup/setup-service.js";
import {
  UninstallService,
  localCleanupTargets,
} from "../setup/uninstall-service.js";
import { discoverPublishDirectory } from "../portrait/obsidian.js";
import { SqliteStateStore } from "../state/sqlite-store.js";

const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

export interface CliDependencies {
  writeOutput?: (value: string) => void;
  secretStoreFactory?: ConfigSecretStoreFactory;
  oauthFactory?: (
    clientFile: string,
    secrets: SecretStore,
  ) => Pick<GoogleOAuth, "beginInteractiveAuthorization" | "getClient">;
  driveFactory?: (auth: GoogleOAuthClient) => drive_v3.Drive;
  writeConfig?: typeof writeConfig;
  runBackfill?: (options: {
    yes: boolean;
    json: boolean;
  }) => Promise<BackfillResult>;
}

export function isAffirmativeConfirmation(value: string): boolean {
  return ["y", "yes"].includes(value.trim().toLowerCase());
}

function sourceList(value: string): SessionSource[] {
  const allowed = new Set<SessionSource>(SESSION_SOURCES);
  const values = value.split(",").map((item) => item.trim()) as SessionSource[];
  if (values.some((item) => !allowed.has(item)))
    throw new Error("Unknown source in --sources");
  return values;
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      total += entry.isDirectory()
        ? await directorySize(child)
        : (await stat(child)).size;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return total;
}

export async function runCli(
  argv = process.argv,
  dependencies: CliDependencies = {},
): Promise<void> {
  const writeOutput =
    dependencies.writeOutput ??
    ((value: string) => process.stdout.write(value));
  const secretStoreFactory =
    dependencies.secretStoreFactory ?? createConfigSecretStore;
  const oauthFactory =
    dependencies.oauthFactory ??
    ((clientFile: string, secrets: SecretStore) =>
      new GoogleOAuth(clientFile, secrets));
  const driveFactory =
    dependencies.driveFactory ??
    ((auth: GoogleOAuthClient) => google.drive({ version: "v3", auth }));
  const persistConfig = dependencies.writeConfig ?? writeConfig;
  const print = (value: unknown, json = false): void => {
    if (json || typeof value !== "string")
      writeOutput(`${JSON.stringify(value, null, 2)}\n`);
    else writeOutput(`${value}\n`);
  };
  const program = new Command();
  const launch = {
    command: process.execPath,
    args: [resolve(argv[1] ?? process.argv[1] ?? "brainhub-mcp")],
  };
  program
    .name("brainhub-mcp")
    .description("BrainHub local session MCP")
    .version(PACKAGE_VERSION)
    .option("--config <path>", "configuration file");

  const load = async (): Promise<LoadedConfig> =>
    loadConfig({
      homeDir: homedir(),
      hostname: hostname(),
      platform: process.platform,
      env: process.env,
      ...(program.opts<{ config?: string }>().config
        ? { configFile: resolve(program.opts<{ config?: string }>().config!) }
        : {}),
    });
  const runtime = async (): Promise<BrainHubRuntime> => {
    const loaded = await load();
    return new BrainHubRuntime({
      config: loaded.config,
      paths: loaded.paths,
      configFile: loaded.configFile,
      homeDir: homedir(),
      platform: process.platform,
      executable: launch.command,
      executableArgs: launch.args,
    });
  };
  const secretsFor = (loaded: LoadedConfig): SecretStore =>
    secretStoreFactory({
      platform: process.platform,
      configFile: loaded.configFile,
      legacyAccount: loaded.config.device.name,
    });
  const rollbackAndRethrow = async (
    staged: Awaited<ReturnType<GoogleOAuth["beginInteractiveAuthorization"]>>,
    error: unknown,
  ): Promise<never> => {
    try {
      await staged.rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Google account connection and rollback both failed",
        { cause: rollbackError },
      );
    }
    throw error;
  };
  const runBackfill =
    dependencies.runBackfill ??
    (async (options: { yes: boolean; json: boolean }) => {
      const loaded = await load();
      const state = new SqliteStateStore(loaded.paths.stateFile, {
        ...(loaded.paths.legacyStateFile
          ? { legacyPath: loaded.paths.legacyStateFile }
          : {}),
      });
      const service = new BackfillService({
        state,
        inspect: async () => {
          const instance = await runtime();
          try {
            const discovery = await instance.discover({});
            const bytes = discovery.sessions.reduce(
              (total, session) =>
                total +
                session.turns.reduce(
                  (turnTotal, turn) =>
                    turnTotal +
                    Buffer.byteLength(turn.text) +
                    turn.images.reduce(
                      (imageTotal, image) =>
                        imageTotal +
                        Buffer.byteLength(
                          image.kind === "embedded" ? image.data : image.url,
                        ),
                      0,
                    ),
                  0,
                ),
              0,
            );
            return { sessions: discovery.sessions.length, bytes };
          } finally {
            instance.close();
          }
        },
        confirm: async (summary) => {
          if (options.yes) return true;
          if (!process.stdin.isTTY) {
            throw new Error(
              "Backfill confirmation requires a terminal or --yes",
            );
          }
          const prompt = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          try {
            const answer = await prompt.question(
              `回填 ${summary.sessions} 个会话（${summary.bytes} bytes）？[Y/n] `,
            );
            return !["n", "no"].includes(answer.trim().toLowerCase());
          } finally {
            prompt.close();
          }
        },
        upload: async (sources) => {
          const instance = await runtime();
          try {
            const result = await instance.uploadSessions({
              backfill: true,
              sources,
            });
            return { uploaded: result.uploaded, pending: result.pending };
          } finally {
            instance.close();
          }
        },
        report: (summary) => {
          if (!options.json) {
            print(
              `发现 ${summary.sessions} 个可回填会话，共 ${summary.bytes} bytes。`,
            );
          }
        },
      });
      try {
        return await service.run();
      } finally {
        state.close();
      }
    });

  program
    .command("setup")
    .description("configure BrainHub MCP on macOS")
    .option("--yes", "accept the default session backfill")
    .option("--drive-root-id <id>", "choose an existing brain-hub folder")
    .option(
      "--obsidian-vault <path>",
      "publish the daily portrait to this vault",
    )
    .option("--json", "machine-readable final output")
    .action(
      async (options: {
        yes?: boolean;
        driveRootId?: string;
        obsidianVault?: string;
        json?: boolean;
      }) => {
        let lastModelPercent = -1;
        const service = new SetupService({
          platform: process.platform,
          ensureConfig: async () => {
            const loaded = await load();
            const nextConfig = options.obsidianVault
              ? {
                  ...loaded.config,
                  publish: {
                    fallbackPath: join(
                      resolve(options.obsidianVault),
                      "BrainHub",
                    ),
                  },
                }
              : loaded.config;
            await persistConfig(loaded.configFile, nextConfig);
          },
          connectGoogle: async () => {
            const loaded = await load();
            const secrets = secretsFor(loaded);
            const credential = await secrets.get();
            const reusable = await resolveReusableGoogleAccount({
              config: loaded.config,
              credential,
              loadAccount: async () => {
                const authClient = await oauthFactory(
                  loaded.config.drive.oauthClientFile,
                  secrets,
                ).getClient({ interactive: false });
                return readGoogleDriveAccount(driveFactory(authClient));
              },
            });
            if (reusable) return reusable;
            if (!options.json) {
              print(
                "即将打开浏览器。请选择 BrainHub 要连接的 Google 账号并同意授权。",
              );
            }
            const staged = await oauthFactory(
              loaded.config.drive.oauthClientFile,
              secrets,
            ).beginInteractiveAuthorization();
            try {
              const connection = await connectGoogleAccount({
                authClient: staged.client,
                drive: driveFactory,
                rootFolderName: loaded.config.drive.rootFolderName,
                ...(options.driveRootId
                  ? { rootFolderId: options.driveRootId }
                  : {}),
              });
              const nextConfig = applyGoogleConnection(
                loaded.config,
                connection,
              );
              await staged.commit();
              await persistConfig(loaded.configFile, nextConfig);
              return { email: connection.account.email };
            } catch (error) {
              return rollbackAndRethrow(staged, error);
            }
          },
          prepareModel: async (progress) => {
            const loaded = await load();
            const embedder = new E5Embedder({
              model: loaded.config.search.model,
              revision: loaded.config.search.modelRevision,
              dimensions: loaded.config.search.dimensions,
              cacheDir: loaded.paths.modelCache,
            });
            await embedder.prepare(progress);
          },
          runBackfill: () =>
            runBackfill({
              yes: options.yes ?? false,
              json: options.json ?? false,
            }),
          inspectClients: async () => {
            const loaded = await load();
            const registry = new ClientRegistry(
              launchWithConfig(launch, loaded.configFile),
            );
            return Object.fromEntries(
              await Promise.all(
                (["claude", "codex", "grok"] as const).map(async (client) => [
                  client,
                  await registry.status(client),
                ]),
              ),
            ) as Record<
              ClientName,
              { available: boolean; registered: boolean }
            >;
          },
          registerClient: async (client) => {
            const loaded = await load();
            await new ClientRegistry(
              launchWithConfig(launch, loaded.configFile),
            ).mutate(client, "install");
          },
          installScheduler: async ({ portrait }) => {
            const loaded = await load();
            await new SchedulerManager({
              platform: process.platform,
              homeDir: homedir(),
              command: launch.command,
              args: [...launch.args, "--config", loaded.configFile],
            }).install(
              loaded.config.scheduler.at,
              loaded.config.scheduler.syncAt,
              { portrait },
            );
          },
          inspectObsidian: async () => {
            const loaded = await load();
            const path = await discoverPublishDirectory({
              platform: process.platform,
              homeDir: homedir(),
              fallbackPath: loaded.config.publish.fallbackPath,
            });
            return path ? { configured: true, path } : { configured: false };
          },
          report: (progress) => {
            if (options.json) return;
            if (progress.type === "backfill-summary") {
              print(
                `发现 ${progress.sessions ?? 0} 个可回填会话，共 ${progress.bytes ?? 0} bytes。`,
              );
              return;
            }
            const percent = Math.floor(progress.percent ?? 0);
            if (percent === lastModelPercent) return;
            lastModelPercent = percent;
            print(
              `模型下载 ${percent}%${progress.file ? ` ${progress.file}` : ""}`,
            );
          },
        });
        print(await service.run(), options.json);
      },
    );

  program
    .command("serve")
    .description("run the stdio MCP server")
    .action(async () => {
      const instance = await runtime();
      await serveMcp(instance);
    });

  const config = program
    .command("config")
    .description("manage BrainHub configuration");
  config
    .command("show")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const loaded = await load();
      print(
        { file: loaded.configFile, config: loaded.config, paths: loaded.paths },
        options.json,
      );
    });
  config
    .command("init")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const loaded = await load();
      await writeConfig(loaded.configFile, loaded.config);
      print({ configured: true, file: loaded.configFile }, options.json);
    });

  program
    .command("upload")
    .description("scan and upload local sessions")
    .option("--dry-run", "plan without Drive or local state writes")
    .option("--backfill", "scan all available history")
    .option("--include-subagents", "include sidechains and subagents")
    .option("--sources <sources>", "comma-separated sources", sourceList)
    .option("--json", "machine-readable output")
    .action(
      async (options: {
        dryRun?: boolean;
        backfill?: boolean;
        includeSubagents?: boolean;
        sources?: SessionSource[];
        json?: boolean;
      }) => {
        const instance = await runtime();
        try {
          const result = await instance.uploadSessions({
            ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
            ...(options.backfill !== undefined
              ? { backfill: options.backfill }
              : {}),
            ...(options.includeSubagents !== undefined
              ? { includeSubagents: options.includeSubagents }
              : {}),
            ...(options.sources ? { sources: options.sources } : {}),
          });
          print(result, options.json);
        } finally {
          instance.close();
        }
      },
    );

  const auth = program.command("auth").description("manage Google OAuth");
  auth
    .command("login")
    .alias("switch")
    .option("--yes", "accept the default session backfill")
    .option("--drive-root-id <id>", "choose an existing brain-hub folder")
    .option("--json")
    .action(
      async (options: {
        yes?: boolean;
        driveRootId?: string;
        json?: boolean;
      }) => {
        const loaded = await load();
        if (!options.json) {
          print(
            "A browser will open. Choose the Google account BrainHub should use.",
          );
        }
        const secrets = secretsFor(loaded);
        const staged = await oauthFactory(
          loaded.config.drive.oauthClientFile,
          secrets,
        ).beginInteractiveAuthorization();
        const connection = await (async () => {
          try {
            const connected = await connectGoogleAccount({
              authClient: staged.client,
              drive: driveFactory,
              rootFolderName: loaded.config.drive.rootFolderName,
              ...(options.driveRootId
                ? { rootFolderId: options.driveRootId }
                : {}),
            });
            const nextConfig = applyGoogleConnection(loaded.config, connected);
            await staged.commit();
            await persistConfig(loaded.configFile, nextConfig);
            return { connected, nextConfig };
          } catch (error) {
            return rollbackAndRethrow(staged, error);
          }
        })();
        const backfill = await runBackfill({
          yes: options.yes ?? false,
          json: options.json ?? false,
        });
        print(
          {
            authenticated: true,
            account: {
              email: connection.connected.account.email,
              displayName: connection.connected.account.displayName,
            },
            drive: {
              rootFolderId: connection.connected.rootFolderId,
              rootFolderName: connection.nextConfig.drive.rootFolderName,
            },
            backfill,
          },
          options.json,
        );
      },
    );
  auth
    .command("status")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const loaded = await load();
      const secrets = secretsFor(loaded);
      const credential = await secrets.get();
      const status = await resolveGoogleAccountStatus({
        config: loaded.config,
        credential,
        loadAccount: async () => {
          const authClient = await oauthFactory(
            loaded.config.drive.oauthClientFile,
            secrets,
          ).getClient({ interactive: false });
          return readGoogleDriveAccount(driveFactory(authClient));
        },
      });
      print(status, options.json);
    });
  auth
    .command("logout")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const loaded = await load();
      const secrets = secretsFor(loaded);
      const previousCredential = await secrets.get();
      await secrets.delete();
      try {
        await persistConfig(
          loaded.configFile,
          clearGoogleConnection(loaded.config),
        );
      } catch (error) {
        try {
          if (previousCredential) await secrets.set(previousCredential);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "Google logout and credential restore both failed",
            { cause: restoreError },
          );
        }
        throw error;
      }
      const warnings: Array<{ code: string; message: string }> = [];
      if (previousCredential) {
        try {
          await revokeGoogleCredential(previousCredential);
        } catch (error) {
          warnings.push({
            code: "OAUTH_REVOCATION_FAILED",
            message:
              error instanceof Error ? error.message : "OAuth revoke failed",
          });
        }
      }
      print(
        {
          authenticated: false,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
        options.json,
      );
    });

  const drive = program
    .command("drive")
    .description("manage the BrainHub Drive root");
  drive
    .command("init")
    .option("--drive-root-id <id>", "choose an existing brain-hub folder")
    .option("--json")
    .action(async (options: { driveRootId?: string; json?: boolean }) => {
      const loaded = await load();
      const secrets = secretsFor(loaded);
      const oauth = await oauthFactory(
        loaded.config.drive.oauthClientFile,
        secrets,
      ).getClient({ interactive: false });
      const connection = await connectGoogleAccount({
        authClient: oauth,
        drive: driveFactory,
        rootFolderName: loaded.config.drive.rootFolderName,
        ...(options.driveRootId ? { rootFolderId: options.driveRootId } : {}),
      });
      await persistConfig(
        loaded.configFile,
        applyGoogleConnection(loaded.config, connection),
      );
      print(
        {
          initialized: true,
          account: {
            email: connection.account.email,
            displayName: connection.account.displayName,
          },
          rootFolderId: connection.rootFolderId,
        },
        options.json,
      );
    });
  drive
    .command("status")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const loaded = await load();
      const exists = Boolean(loaded.config.drive.rootFolderId);
      print(
        {
          configured: exists,
          rootFolderId: loaded.config.drive.rootFolderId || undefined,
          accountEmail: loaded.config.drive.accountEmail || undefined,
        },
        options.json,
      );
    });

  const search = program
    .command("search")
    .description("hybrid semantic search");
  search
    .command("query <query>")
    .option("--limit <number>", "maximum results", Number)
    .option("--json")
    .action(
      async (query: string, options: { limit?: number; json?: boolean }) => {
        const instance = await runtime();
        try {
          print(
            await instance.searchSessions({
              query,
              ...(options.limit ? { limit: options.limit } : {}),
            }),
            options.json,
          );
        } finally {
          instance.close();
        }
      },
    );
  search
    .command("sync")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const instance = await runtime();
      try {
        const result = await instance
          .searchService(await instance.drive(false))
          .sync();
        print({ synced: true, ...result }, options.json);
      } finally {
        instance.close();
      }
    });
  search
    .command("reindex")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const instance = await runtime();
      try {
        const drivePort = await instance.drive(false);
        await rm(instance.paths.searchIndexFile, { force: true });
        const result = await instance.searchService(drivePort).sync();
        print({ reindexed: true, ...result }, options.json);
      } finally {
        instance.close();
      }
    });
  const model = search.command("model");
  model
    .command("status")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const loaded = await load();
      print(
        {
          cachePath: loaded.paths.modelCache,
          bytes: await directorySize(loaded.paths.modelCache),
        },
        options.json,
      );
    });
  model
    .command("clear")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const loaded = await load();
      await rm(loaded.paths.modelCache, { recursive: true, force: true });
      print(
        { cleared: true, cachePath: loaded.paths.modelCache },
        options.json,
      );
    });

  const portrait = program.command("portrait");
  portrait
    .command("get")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const instance = await runtime();
      try {
        print(await instance.getPortrait(), options.json);
      } finally {
        instance.close();
      }
    });
  portrait
    .command("sync")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const instance = await runtime();
      try {
        print(await instance.syncPortrait(), options.json);
      } finally {
        instance.close();
      }
    });
  program
    .command("status")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const instance = await runtime();
      try {
        print(await instance.hubStatus(), options.json);
      } finally {
        instance.close();
      }
    });

  const clients = program.command("clients");
  for (const action of ["install", "uninstall"] as const) {
    const clientCommand = clients
      .command(`${action} [client]`)
      .option("--all")
      .option("--desktop", "also merge Claude Desktop config");
    if (action === "install") {
      clientCommand.option(
        "--no-scheduler",
        "register clients without enabling daily uploads",
      );
    }
    clientCommand.option("--json").action(
      async (
        client: ClientName | undefined,
        options: {
          all?: boolean;
          desktop?: boolean;
          scheduler?: boolean;
          json?: boolean;
        },
      ) => {
        const registry = new ClientRegistry(launch);
        const targets: ClientName[] = options.all
          ? ["claude", "codex", "grok"]
          : client
            ? [client]
            : [];
        if (targets.length === 0) throw new Error("Specify a client or --all");
        for (const target of targets) await registry.mutate(target, action);
        if (action === "install" && options.desktop) {
          const desktopPath =
            process.platform === "darwin"
              ? join(
                  homedir(),
                  "Library",
                  "Application Support",
                  "Claude",
                  "claude_desktop_config.json",
                )
              : join(
                  homedir(),
                  ".config",
                  "Claude",
                  "claude_desktop_config.json",
                );
          await mergeClaudeDesktopConfig(desktopPath, launch);
        }
        let scheduler:
          | { installed: true; at: string; syncAt: string }
          | { installed: false }
          | undefined;
        if (action === "install") {
          if (options.scheduler === false) {
            scheduler = { installed: false };
          } else {
            const loaded = await load();
            const at = loaded.config.scheduler.at;
            const syncAt = loaded.config.scheduler.syncAt;
            await new SchedulerManager({
              platform: process.platform,
              homeDir: homedir(),
              command: launch.command,
              args: [...launch.args, "--config", loaded.configFile],
            }).install(at, syncAt);
            scheduler = { installed: true, at, syncAt };
          }
        }
        print(
          {
            action,
            clients: targets,
            desktop: Boolean(options.desktop),
            ...(scheduler ? { scheduler } : {}),
          },
          options.json,
        );
      },
    );
  }
  clients
    .command("status")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const registry = new ClientRegistry(launch);
      const result = Object.fromEntries(
        await Promise.all(
          (["claude", "codex", "grok"] as const).map(async (name) => [
            name,
            await registry.status(name),
          ]),
        ),
      );
      print(result, options.json);
    });

  const scheduler = program.command("scheduler");
  scheduler
    .command("install")
    .option("--at <time>")
    .option("--sync-at <time>")
    .option("--json")
    .action(
      async (options: { at?: string; syncAt?: string; json?: boolean }) => {
        const loaded = await load();
        const at = options.at ?? loaded.config.scheduler.at;
        const syncAt = options.syncAt ?? loaded.config.scheduler.syncAt;
        const manager = new SchedulerManager({
          platform: process.platform,
          homeDir: homedir(),
          command: launch.command,
          args: [...launch.args, "--config", loaded.configFile],
        });
        await manager.install(at, syncAt);
        print({ installed: true, at, syncAt }, options.json);
      },
    );
  scheduler
    .command("uninstall")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const manager = new SchedulerManager({
        platform: process.platform,
        homeDir: homedir(),
        command: launch.command,
        args: launch.args,
      });
      await manager.uninstall();
      print({ installed: false }, options.json);
    });
  scheduler
    .command("status")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const manager = new SchedulerManager({
        platform: process.platform,
        homeDir: homedir(),
        command: launch.command,
        args: launch.args,
      });
      print(await manager.status(), options.json);
    });

  program
    .command("uninstall")
    .description("remove BrainHub MCP integrations and local state")
    .option("--yes", "confirm removal without an interactive prompt")
    .option("--json")
    .action(async (options: { yes?: boolean; json?: boolean }) => {
      if (!options.yes) {
        if (!process.stdin.isTTY) {
          throw new BrainHubError(
            "CONFIRMATION_REQUIRED",
            "Run `brainhub-mcp uninstall --yes` to confirm local data removal",
          );
        }
        const prompt = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const answer = await prompt.question(
            "移除客户端注册、授权、Keychain、配置、索引和模型缓存？Drive 与 Obsidian 内容会保留。[y/N] ",
          );
          if (!isAffirmativeConfirmation(answer)) {
            print({ uninstalled: false, cancelled: true }, options.json);
            return;
          }
        } finally {
          prompt.close();
        }
      }
      const loaded = await load();
      const secrets = secretsFor(loaded);
      const credential = await secrets.get();
      const registry = new ClientRegistry(launch);
      const scheduler = new SchedulerManager({
        platform: process.platform,
        homeDir: homedir(),
        command: launch.command,
        args: [...launch.args, "--config", loaded.configFile],
      });
      const result = await new UninstallService({
        platform: process.platform,
        inspectClients: async () =>
          Object.fromEntries(
            await Promise.all(
              (["claude", "codex", "grok"] as const).map(async (client) => [
                client,
                await registry.status(client),
              ]),
            ),
          ) as Record<ClientName, { available: boolean; registered: boolean }>,
        unregisterClient: (client) => registry.mutate(client, "uninstall"),
        uninstallScheduler: () => scheduler.uninstall(),
        revokeGoogle: () =>
          credential
            ? revokeGoogleCredential(credential)
            : Promise.resolve(false),
        clearKeychain: () => secrets.delete(),
        removeLocalState: async () => {
          const targets = localCleanupTargets(
            loaded.paths.stateFile,
            loaded.paths.modelCache,
          );
          await Promise.all([
            rm(loaded.configFile, { force: true }),
            rm(targets.dataDirectory, { recursive: true, force: true }),
            rm(targets.modelCache, { recursive: true, force: true }),
          ]);
        },
      }).run();
      print(result, options.json);
    });

  await program.parseAsync(argv);
}

const invokedDirectly =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) ===
    realpathSync(resolve(process.argv[1]));
if (invokedDirectly) {
  runCli().catch((error: unknown) => {
    const candidate = error as { code?: unknown; message?: unknown };
    const code =
      typeof candidate.code === "string" ? candidate.code : "INTERNAL_ERROR";
    const message =
      typeof candidate.message === "string"
        ? candidate.message
        : "BrainHub command failed";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  });
}
