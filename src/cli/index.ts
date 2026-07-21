#!/usr/bin/env node

import { readdir, rm, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Command } from "commander";
import { google, type drive_v3 } from "googleapis";

import { resolveGoogleAccountStatus } from "../auth/account-status.js";
import {
  applyGoogleConnection,
  clearGoogleConnection,
  connectGoogleAccount,
  readGoogleDriveAccount,
} from "../auth/google-account.js";
import { GoogleOAuth, type GoogleOAuthClient } from "../auth/google-oauth.js";
import {
  createConfigSecretStore,
  type ConfigSecretStoreFactory,
} from "../auth/secret-store-factory.js";
import type { SecretStore } from "../auth/secret-store.js";
import {
  ClientRegistry,
  mergeClaudeDesktopConfig,
  type ClientName,
} from "../clients/registry.js";
import {
  loadConfig,
  writeConfig,
  type LoadedConfig,
} from "../domain/config-io.js";
import type { SessionSource } from "../domain/session.js";
import { serveMcp } from "../mcp/server.js";
import { BrainHubRuntime } from "../runtime/container.js";
import { SchedulerManager } from "../scheduler/manager.js";

export interface CliDependencies {
  writeOutput?: (value: string) => void;
  secretStoreFactory?: ConfigSecretStoreFactory;
  oauthFactory?: (
    clientFile: string,
    secrets: SecretStore,
  ) => Pick<GoogleOAuth, "beginInteractiveAuthorization" | "getClient">;
  driveFactory?: (auth: GoogleOAuthClient) => drive_v3.Drive;
  writeConfig?: typeof writeConfig;
}

function sourceList(value: string): SessionSource[] {
  const allowed = new Set<SessionSource>([
    "claude-code",
    "codex",
    "grok-build",
  ]);
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
    args: [resolve(argv[1] ?? process.argv[1] ?? "brain-mcp")],
  };
  program
    .name("brain-mcp")
    .description("BrainHub local session MCP")
    .version("0.1.0")
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
    .option("--skip-index", "upload without refreshing the search index")
    .option("--include-subagents", "include sidechains and subagents")
    .option("--sources <sources>", "comma-separated sources", sourceList)
    .option("--json", "machine-readable output")
    .action(
      async (options: {
        dryRun?: boolean;
        backfill?: boolean;
        includeSubagents?: boolean;
        skipIndex?: boolean;
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
            ...(options.skipIndex !== undefined
              ? { skipIndex: options.skipIndex }
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
    .option("--json")
    .action(async (options: { json?: boolean }) => {
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
      try {
        const connection = await connectGoogleAccount({
          authClient: staged.client,
          drive: driveFactory,
          rootFolderName: loaded.config.drive.rootFolderName,
        });
        const nextConfig = applyGoogleConnection(loaded.config, connection);
        await staged.commit();
        await persistConfig(loaded.configFile, nextConfig);
        print(
          {
            authenticated: true,
            account: {
              email: connection.account.email,
              displayName: connection.account.displayName,
            },
            drive: {
              rootFolderId: connection.rootFolderId,
              rootFolderName: nextConfig.drive.rootFolderName,
            },
          },
          options.json,
        );
      } catch (error) {
        await rollbackAndRethrow(staged, error);
      }
    });
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
      print({ authenticated: false }, options.json);
    });

  const drive = program
    .command("drive")
    .description("manage the BrainHub Drive root");
  drive
    .command("init")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
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
        const manifest = await instance
          .searchService(await instance.drive(false))
          .sync();
        print(
          { synced: true, references: manifest.references.length },
          options.json,
        );
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
        const old = await drivePort.list({ prefix: "_meta/search/v1/" });
        for (const entry of old) await drivePort.trash(entry.id);
        const manifest = await instance.searchService(drivePort).sync();
        print(
          { reindexed: true, references: manifest.references.length },
          options.json,
        );
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
    .command("pull")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const instance = await runtime();
      try {
        print(await instance.pullPortrait(), options.json);
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
          { installed: true; at: string } | { installed: false } | undefined;
        if (action === "install") {
          if (options.scheduler === false) {
            scheduler = { installed: false };
          } else {
            const loaded = await load();
            const at = loaded.config.scheduler.at;
            await new SchedulerManager({
              platform: process.platform,
              homeDir: homedir(),
              command: launch.command,
              args: [...launch.args, "--config", loaded.configFile],
            }).install(at);
            scheduler = { installed: true, at };
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
    .option("--json")
    .action(async (options: { at?: string; json?: boolean }) => {
      const loaded = await load();
      const at = options.at ?? loaded.config.scheduler.at;
      const manager = new SchedulerManager({
        platform: process.platform,
        homeDir: homedir(),
        command: launch.command,
        args: launch.args,
      });
      await manager.install(at);
      print({ installed: true, at }, options.json);
    });
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

  await program.parseAsync(argv);
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
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
