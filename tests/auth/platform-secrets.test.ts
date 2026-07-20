import { describe, expect, it } from "vitest";

import {
  PlatformSecretStore,
  type CommandRunner,
} from "../../src/auth/platform-secrets.js";
import {
  createConfigSecretStore,
  credentialStoreAccount,
} from "../../src/auth/secret-store-factory.js";

describe("platform secret storage", () => {
  it("uses macOS Keychain without putting tokens in output", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      input: string | undefined;
    }> = [];
    const store = new PlatformSecretStore({
      platform: "darwin",
      account: "user@example.com",
      runner: async (command, args, input) => {
        calls.push({ command, args, input });
        return command === "security" && args[0] === "find-generic-password"
          ? "token-value\n"
          : "";
      },
    });

    await store.set("refresh-secret");
    expect(await store.get()).toBe("token-value");
    expect(calls[0]).toMatchObject({ command: "security" });
    expect(calls[0]?.args.slice(-2)).toEqual(["-w", "refresh-secret"]);
    expect(calls[0]?.input).toBeUndefined();
  });

  it("uses Linux Secret Service", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      input: string | undefined;
    }> = [];
    const store = new PlatformSecretStore({
      platform: "linux",
      account: "default",
      runner: async (command, args, input) => {
        calls.push({ command, args, input });
        return args[0] === "lookup" ? "saved-token" : "";
      },
    });
    await store.set("secret");
    expect(await store.get()).toBe("saved-token");
    expect(calls.every((call) => call.command === "secret-tool")).toBe(true);
    expect(calls[0]?.input).toBe("secret");
  });

  it("uses a stable credential account per resolved config file", () => {
    expect(credentialStoreAccount("/tmp/a/../a/config.toml")).toBe(
      credentialStoreAccount("/tmp/a/config.toml"),
    );
    expect(credentialStoreAccount("/tmp/a/config.toml")).not.toBe(
      credentialStoreAccount("/tmp/b/config.toml"),
    );
  });

  it("migrates a legacy device credential to the config-specific account", async () => {
    const values = new Map<string, string>([["same-device", "legacy-token"]]);
    const runner: CommandRunner = async (_command, args) => {
      const account = args[args.indexOf("-a") + 1];
      if (args[0] === "find-generic-password") {
        if (account && values.has(account)) return `${values.get(account)}\n`;
        const error = new Error("item not found") as Error & {
          exitCode: number;
        };
        error.exitCode = 44;
        throw error;
      }
      if (args[0] === "add-generic-password" && account) {
        values.set(account, args.at(-1)!);
        return "";
      }
      if (args[0] === "delete-generic-password" && account) {
        values.delete(account);
        return "";
      }
      throw new Error("unexpected command");
    };
    const configFile = "/tmp/one/config.toml";
    const store = createConfigSecretStore({
      platform: "darwin",
      configFile,
      legacyAccount: "same-device",
      runner,
    });

    expect(await store.get()).toBe("legacy-token");
    expect(values.get(credentialStoreAccount(configFile))).toBe("legacy-token");
    expect(values.has("same-device")).toBe(false);
  });

  it("ignores a missing Keychain item but propagates other delete failures", async () => {
    const missing = new PlatformSecretStore({
      platform: "darwin",
      account: "missing",
      runner: async () => {
        const error = new Error("item not found") as Error & {
          exitCode: number;
        };
        error.exitCode = 44;
        throw error;
      },
    });
    await expect(missing.delete()).resolves.toBeUndefined();

    const broken = new PlatformSecretStore({
      platform: "darwin",
      account: "broken",
      runner: async () => {
        const error = new Error("Keychain unavailable") as Error & {
          exitCode: number;
        };
        error.exitCode = 1;
        throw error;
      },
    });
    await expect(broken.delete()).rejects.toThrow(/Keychain unavailable/);
  });
});
