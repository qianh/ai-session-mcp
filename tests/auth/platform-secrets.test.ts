import { describe, expect, it } from "vitest";

import { PlatformSecretStore } from "../../src/auth/platform-secrets.js";

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
});
