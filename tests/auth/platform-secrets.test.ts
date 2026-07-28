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

  it("rejects non-macOS secret storage", () => {
    expect(
      () =>
        new PlatformSecretStore({
          platform: "linux",
          account: "default",
        }),
    ).toThrow("BrainHub MCP v1 supports macOS only");
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
    const service = "brainhub-mcp-google-oauth";
    const values = new Map<string, string>([
      [`${service}:same-device`, "legacy-token"],
    ]);
    const runner: CommandRunner = async (_command, args) => {
      const requestedService = args[args.indexOf("-s") + 1];
      const account = args[args.indexOf("-a") + 1];
      const key = `${requestedService}:${account}`;
      if (args[0] === "find-generic-password") {
        if (values.has(key)) return `${values.get(key)}\n`;
        const error = new Error("item not found") as Error & {
          exitCode: number;
        };
        error.exitCode = 44;
        throw error;
      }
      if (args[0] === "add-generic-password" && account) {
        values.set(key, args.at(-1)!);
        return "";
      }
      if (args[0] === "delete-generic-password" && account) {
        values.delete(key);
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
    expect(values.get(`${service}:${credentialStoreAccount(configFile)}`)).toBe(
      "legacy-token",
    );
    expect(values.has(`${service}:same-device`)).toBe(false);
  });

  it("migrates a credential stored under the pre-rename service", async () => {
    const configFile = "/tmp/renamed/config.toml";
    const account = credentialStoreAccount(configFile);
    const oldKey = `brain-mcp-google-oauth:${account}`;
    const newKey = `brainhub-mcp-google-oauth:${account}`;
    const values = new Map<string, string>([[oldKey, "legacy-token"]]);
    const runner: CommandRunner = async (_command, args) => {
      const service = args[args.indexOf("-s") + 1];
      const requestedAccount = args[args.indexOf("-a") + 1];
      const key = `${service}:${requestedAccount}`;
      if (args[0] === "find-generic-password") {
        if (values.has(key)) return `${values.get(key)}\n`;
        const error = new Error("item not found") as Error & {
          exitCode: number;
        };
        error.exitCode = 44;
        throw error;
      }
      if (args[0] === "add-generic-password") {
        values.set(key, args.at(-1)!);
        return "";
      }
      if (args[0] === "delete-generic-password") {
        values.delete(key);
        return "";
      }
      throw new Error("unexpected command");
    };
    const store = createConfigSecretStore({
      platform: "darwin",
      configFile,
      legacyAccount: "same-device",
      runner,
    });

    expect(await store.get()).toBe("legacy-token");
    expect(values.get(newKey)).toBe("legacy-token");
    expect(values.has(oldKey)).toBe(false);
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
