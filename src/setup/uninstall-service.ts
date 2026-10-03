import { dirname } from "node:path";

import { CLIENT_NAMES, type ClientName } from "../clients/registry.js";
import { assertSupportedPlatform } from "../domain/platform.js";

type ClientStatuses = Record<
  ClientName,
  { available: boolean; registered: boolean }
>;

interface UninstallDependencies {
  platform: NodeJS.Platform;
  inspectClients(): Promise<ClientStatuses>;
  unregisterClient(client: ClientName): Promise<void>;
  uninstallClientSkills(client: ClientName): Promise<void>;
  uninstallScheduler(): Promise<void>;
  revokeGoogle(): Promise<boolean>;
  clearKeychain(): Promise<void>;
  removeLocalState(): Promise<void>;
}

export interface UninstallOutput {
  uninstalled: boolean;
  clients: ClientName[];
  oauthRevoked: boolean;
  warnings: Array<{ code: string; message: string }>;
}

export function brainHubDataDirectory(accountStateFile: string): string {
  return dirname(dirname(dirname(accountStateFile)));
}

export function localCleanupTargets(
  accountStateFile: string,
  modelCache: string,
): { dataDirectory: string; modelCache: string } {
  return {
    dataDirectory: brainHubDataDirectory(accountStateFile),
    modelCache,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown uninstall error";
}

export class UninstallService {
  constructor(readonly dependencies: UninstallDependencies) {}

  async run(): Promise<UninstallOutput> {
    assertSupportedPlatform(this.dependencies.platform);
    const warnings: UninstallOutput["warnings"] = [];
    const removedClients: ClientName[] = [];
    try {
      const statuses = await this.dependencies.inspectClients();
      for (const client of CLIENT_NAMES) {
        if (!statuses[client].registered) {
          try {
            await this.dependencies.uninstallClientSkills(client);
          } catch (error) {
            warnings.push({
              code: "CLIENT_SKILLS_UNINSTALL_FAILED",
              message: `${client}: ${message(error)}`,
            });
          }
          continue;
        }
        try {
          await this.dependencies.unregisterClient(client);
          removedClients.push(client);
        } catch (error) {
          warnings.push({
            code: "CLIENT_UNINSTALL_FAILED",
            message: `${client}: ${message(error)}`,
          });
        }
      }
    } catch (error) {
      warnings.push({
        code: "CLIENT_STATUS_FAILED",
        message: message(error),
      });
    }

    try {
      await this.dependencies.uninstallScheduler();
    } catch (error) {
      warnings.push({
        code: "SCHEDULER_UNINSTALL_FAILED",
        message: message(error),
      });
    }

    let oauthRevoked = false;
    try {
      oauthRevoked = await this.dependencies.revokeGoogle();
    } catch (error) {
      warnings.push({
        code: "OAUTH_REVOCATION_FAILED",
        message: message(error),
      });
    }

    let localCleanupComplete = true;
    try {
      await this.dependencies.clearKeychain();
    } catch (error) {
      localCleanupComplete = false;
      warnings.push({ code: "KEYCHAIN_CLEAR_FAILED", message: message(error) });
    }
    try {
      await this.dependencies.removeLocalState();
    } catch (error) {
      localCleanupComplete = false;
      warnings.push({ code: "LOCAL_CLEANUP_FAILED", message: message(error) });
    }
    return {
      uninstalled: localCleanupComplete,
      clients: removedClients,
      oauthRevoked,
      warnings,
    };
  }
}
