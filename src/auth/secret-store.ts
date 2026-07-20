export interface SecretStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
}

export class MigratingSecretStore implements SecretStore {
  constructor(
    readonly primary: SecretStore,
    readonly legacy: SecretStore,
  ) {}

  async get(): Promise<string | null> {
    const current = await this.primary.get();
    if (current) return current;
    const legacy = await this.legacy.get();
    if (!legacy) return null;
    await this.primary.set(legacy);
    await this.legacy.delete();
    return legacy;
  }

  async set(value: string): Promise<void> {
    await this.primary.set(value);
  }

  async delete(): Promise<void> {
    const previous = await this.primary.get();
    await this.primary.delete();
    try {
      await this.legacy.delete();
    } catch (error) {
      try {
        if (previous !== null) await this.primary.set(previous);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Legacy credential deletion and primary credential restore both failed",
          { cause: restoreError },
        );
      }
      throw error;
    }
  }
}
