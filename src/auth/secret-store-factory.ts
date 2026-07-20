import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { PlatformSecretStore, type CommandRunner } from "./platform-secrets.js";
import { MigratingSecretStore, type SecretStore } from "./secret-store.js";

export interface ConfigSecretStoreOptions {
  platform: NodeJS.Platform;
  configFile: string;
  legacyAccount: string;
  runner?: CommandRunner;
}

export type ConfigSecretStoreFactory = (
  options: ConfigSecretStoreOptions,
) => SecretStore;

export function credentialStoreAccount(configFile: string): string {
  const digest = createHash("sha256")
    .update(resolve(configFile))
    .digest("hex")
    .slice(0, 32);
  return `config-${digest}`;
}

export function createConfigSecretStore(
  options: ConfigSecretStoreOptions,
): SecretStore {
  const common = {
    platform: options.platform,
    ...(options.runner ? { runner: options.runner } : {}),
  };
  const primary = new PlatformSecretStore({
    ...common,
    account: credentialStoreAccount(options.configFile),
  });
  const legacy = new PlatformSecretStore({
    ...common,
    account: options.legacyAccount,
  });
  return new MigratingSecretStore(primary, legacy);
}
