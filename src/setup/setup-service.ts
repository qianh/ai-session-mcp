import { BrainHubError } from "../domain/errors.js";
import { CLIENT_NAMES, type ClientName } from "../clients/registry.js";
import type { BackfillResult } from "./backfill-service.js";

export type { BackfillSummary } from "./backfill-service.js";

export interface SetupProgress {
  type: "model-progress" | "backfill-summary";
  percent?: number;
  file?: string;
  sessions?: number;
  bytes?: number;
}

type ClientStatuses = Record<
  ClientName,
  { available: boolean; registered: boolean }
>;

export interface SetupDependencies {
  platform: NodeJS.Platform;
  ensureConfig(): Promise<void>;
  connectGoogle(): Promise<{ email: string }>;
  prepareModel(
    progress: (value: { percent?: number; file?: string }) => void,
  ): Promise<void>;
  runBackfill(): Promise<BackfillResult>;
  inspectClients(): Promise<ClientStatuses>;
  registerClient(client: ClientName): Promise<void>;
  installClientSkills(client: ClientName): Promise<void>;
  installScheduler(options: { portrait: boolean }): Promise<void>;
  inspectObsidian(): Promise<{ configured: boolean; path?: string }>;
  report(progress: SetupProgress): void;
}

export interface SetupOutput {
  account: { email: string };
  model: { ready: boolean };
  backfill: BackfillResult;
  clients: { registered: ClientName[]; skipped: ClientName[] };
  scheduler: { installed: boolean };
  obsidian: { configured: boolean; path?: string };
  warnings: Array<{ code: string; message: string }>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown setup error";
}

export class SetupService {
  constructor(readonly dependencies: SetupDependencies) {}

  async run(): Promise<SetupOutput> {
    if (this.dependencies.platform !== "darwin") {
      throw new BrainHubError(
        "PLATFORM_UNSUPPORTED",
        "BrainHub MCP v1 supports macOS only",
      );
    }
    const warnings: SetupOutput["warnings"] = [];
    await this.dependencies.ensureConfig();
    const account = await this.dependencies.connectGoogle();

    let modelReady = true;
    try {
      await this.dependencies.prepareModel((progress) =>
        this.dependencies.report({ type: "model-progress", ...progress }),
      );
    } catch (error) {
      modelReady = false;
      warnings.push({
        code: "MODEL_DOWNLOAD_FAILED",
        message: message(error),
      });
    }

    const backfill = await this.dependencies.runBackfill();
    if (backfill.confirmed && !backfill.completed) {
      warnings.push({
        code: "BACKFILL_INCOMPLETE",
        message: "History backfill has retryable uploads remaining",
      });
    }

    const statuses = await this.dependencies.inspectClients();
    const registered: ClientName[] = [];
    const skipped: ClientName[] = [];
    for (const client of CLIENT_NAMES) {
      const status = statuses[client];
      if (!status.available) {
        skipped.push(client);
        continue;
      }
      if (status.registered) {
        skipped.push(client);
        try {
          await this.dependencies.installClientSkills(client);
        } catch (error) {
          warnings.push({
            code: "CLIENT_SKILLS_INSTALL_FAILED",
            message: `${client}: ${message(error)}`,
          });
        }
        continue;
      }
      try {
        await this.dependencies.registerClient(client);
        registered.push(client);
      } catch (error) {
        warnings.push({
          code: "CLIENT_REGISTRATION_FAILED",
          message: `${client}: ${message(error)}`,
        });
      }
    }

    let obsidian: SetupOutput["obsidian"];
    try {
      obsidian = await this.dependencies.inspectObsidian();
    } catch (error) {
      obsidian = { configured: false };
      warnings.push({
        code: "OBSIDIAN_DISCOVERY_FAILED",
        message: message(error),
      });
    }

    let schedulerInstalled = true;
    try {
      await this.dependencies.installScheduler({
        portrait: obsidian.configured,
      });
    } catch (error) {
      schedulerInstalled = false;
      warnings.push({
        code: "SCHEDULER_INSTALL_FAILED",
        message: message(error),
      });
    }
    return {
      account,
      model: { ready: modelReady },
      backfill,
      clients: { registered, skipped },
      scheduler: { installed: schedulerInstalled },
      obsidian,
      warnings,
    };
  }
}
