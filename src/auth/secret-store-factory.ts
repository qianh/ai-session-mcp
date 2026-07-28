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
  const account = credentialStoreAccount(options.configFile);
  const primary = new PlatformSecretStore({
    ...common,
    account,
  });
  const legacyAccount = new PlatformSecretStore({
    ...common,
    account: options.legacyAccount,
  });
  const renamedService = new MigratingSecretStore(
    new PlatformSecretStore({
      ...common,
      service: "brain-mcp-google-oauth",
      account,
    }),
    new PlatformSecretStore({
      ...common,
      service: "brain-mcp-google-oauth",
      account: options.legacyAccount,
    }),
  );
  return new MigratingSecretStore(
    primary,
    new MigratingSecretStore(legacyAccount, renamedService),
  );
}
