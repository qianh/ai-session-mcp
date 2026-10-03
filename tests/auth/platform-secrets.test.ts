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

  it("rejects secret storage outside macOS and Linux", () => {
    expect(
      () =>
        new PlatformSecretStore({
          platform: "win32",
          account: "default",
        }),
    ).toThrow("BrainHub MCP supports macOS and Linux");
  });

  it("stores Linux secrets through secret-tool stdin", async () => {
    const values = new Map<string, string>();
    const calls: Array<{ args: string[]; input: string | undefined }> = [];
    const runner: CommandRunner = async (command, args, input) => {
      expect(command).toBe("secret-tool");
      calls.push({ args, input });
      const service = args[args.indexOf("service") + 1] ?? "";
      const account = args[args.indexOf("account") + 1] ?? "";
      const key = `${service}:${account}`;
      if (args[0] === "search") return "";
      if (args[0] === "lookup") {
        if (!values.has(key)) {
          const error = new Error("secret-tool exited with 1:") as Error & {
            exitCode: number;
          };
          error.exitCode = 1;
          throw error;
        }
        return `${values.get(key)}\n`;
      }
      if (args[0] === "store") {
        values.set(key, input ?? "");
        return "";
      }
      if (args[0] === "clear") {
        if (!values.has(key)) {
          const error = new Error("secret-tool exited with 1:") as Error & {
            exitCode: number;
          };
          error.exitCode = 1;
          throw error;
        }
        values.delete(key);
        return "";
      }
      throw new Error(`unexpected ${args[0]}`);
    };
    const store = new PlatformSecretStore({
      platform: "linux",
      account: "config-abc",
      runner,
    });

    await store.probe();
    await store.set("refresh-secret");
    expect(await store.get()).toBe("refresh-secret");
    await store.delete();
    await store.delete();
    expect(await store.get()).toBeNull();
    expect(calls[0]?.args).toEqual([
      "search",
      "service",
      "brainhub-mcp-google-oauth",
    ]);
    expect(calls[1]).toEqual({
      args: [
        "store",
        "--label",
        "BrainHub MCP Google OAuth",
        "service",
        "brainhub-mcp-google-oauth",
        "account",
        "config-abc",
      ],
      input: "refresh-secret",
    });
    expect(calls[1]?.args).not.toContain("refresh-secret");
  });

  it("reports a missing secret-tool and an unavailable Secret Service", async () => {
    const missing = new PlatformSecretStore({
      platform: "linux",
      account: "default",
      runner: async () => {
        const error = new Error("spawn secret-tool ENOENT") as Error & {
          code: string;
        };
        error.code = "ENOENT";
        throw error;
      },
    });
    await expect(missing.probe()).rejects.toMatchObject({
      code: "SECRET_STORE_UNAVAILABLE",
      message: expect.stringMatching(/libsecret/),
    });

    const offline = new PlatformSecretStore({
      platform: "linux",
      account: "default",
      runner: async () => {
        const error = new Error(
          "secret-tool exited with 1: The name org.freedesktop.secrets was not provided by any .service files",
        ) as Error & { exitCode: number };
        error.exitCode = 1;
        throw error;
      },
    });
    await expect(offline.probe()).rejects.toMatchObject({
      code: "SECRET_STORE_UNAVAILABLE",
      message: expect.stringMatching(/gnome-keyring or kwallet/),
    });

    const broken = new PlatformSecretStore({
      platform: "linux",
      account: "broken",
      runner: async () => {
        const error = new Error(
          "secret-tool exited with 1: The name org.freedesktop.secrets was not provided by any .service files",
        ) as Error & { exitCode: number };
        error.exitCode = 1;
        throw error;
      },
    });
    await expect(broken.delete()).rejects.toThrow(/freedesktop\.secrets/);
  });

  it("reports a locked or unreachable Secret Service instead of a missing credential", async () => {
    const locked = new PlatformSecretStore({
      platform: "linux",
      account: "default",
      runner: async () => {
        const error = new Error(
          "secret-tool exited with 1: Cannot get secret of a locked object",
        ) as Error & { exitCode: number; stderr: string };
        error.exitCode = 1;
        error.stderr = "Cannot get secret of a locked object";
        throw error;
      },
    });
    await expect(locked.get()).rejects.toMatchObject({
      code: "SECRET_STORE_UNAVAILABLE",
      message: expect.stringMatching(/locked object/),
    });

    const missingTool = new PlatformSecretStore({
      platform: "linux",
      account: "default",
      runner: async () => {
        const error = new Error("spawn secret-tool ENOENT") as Error & {
          code: string;
        };
        error.code = "ENOENT";
        throw error;
      },
    });
    await expect(missingTool.get()).rejects.toMatchObject({
      code: "SECRET_STORE_UNAVAILABLE",
    });
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
