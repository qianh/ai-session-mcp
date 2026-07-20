import { describe, expect, it } from "vitest";

import {
  MigratingSecretStore,
  type SecretStore,
} from "../../src/auth/secret-store.js";

class MemorySecretStore implements SecretStore {
  constructor(public value: string | null) {}

  async get(): Promise<string | null> {
    return this.value;
  }

  async set(value: string): Promise<void> {
    this.value = value;
  }

  async delete(): Promise<void> {
    this.value = null;
  }
}

describe("migrating secret store", () => {
  it("restores the primary credential when legacy deletion fails", async () => {
    const primary = new MemorySecretStore("credential");
    const legacy = new MemorySecretStore("legacy-credential");
    legacy.delete = async () => {
      throw new Error("legacy keychain unavailable");
    };
    const secrets = new MigratingSecretStore(primary, legacy);

    await expect(secrets.delete()).rejects.toThrow(
      /legacy keychain unavailable/,
    );

    await expect(primary.get()).resolves.toBe("credential");
  });
});
