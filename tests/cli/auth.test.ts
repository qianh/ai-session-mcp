import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SecretStore } from "../../src/auth/secret-store.js";
import { runCli } from "../../src/cli/index.js";
import { createDefaultConfig } from "../../src/domain/config.js";
import { loadConfig, writeConfig } from "../../src/domain/config-io.js";

async function configFixture() {
  const directory = await mkdtemp(join(tmpdir(), "brainhub-cli-auth-"));
  const configFile = join(directory, "config.toml");
  const config = createDefaultConfig({
    hostname: `test-device-${directory.split("-").at(-1)}`,
    homeDir: directory,
    platform: process.platform,
  });
  await writeConfig(configFile, config);
  return { configFile, config };
}

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

function connectedDrive(
  options: {
    permissionId?: string;
    rootFolderId?: string;
    rootError?: Error;
  } = {},
) {
  return {
    about: {
      get: async () => ({
        data: {
          user: {
            emailAddress: "person@example.com",
            displayName: "Person",
            permissionId:
              options.permissionId === undefined
                ? "permission-1"
                : options.permissionId,
          },
        },
      }),
    },
    files: {
      list: async () => {
        if (options.rootError) throw options.rootError;
        return {
          data: { files: [{ id: options.rootFolderId ?? "root-1" }] },
        };
      },
      create: async () => ({ data: { id: options.rootFolderId ?? "root-1" } }),
    },
  };
}

function stagedAuthorization(
  options: {
    events?: string[];
    commitError?: Error;
  } = {},
) {
  let commits = 0;
  let rollbacks = 0;
  return {
    session: {
      client: { marker: "selected-account" } as never,
      commit: async () => {
        commits += 1;
        options.events?.push("commit");
        if (options.commitError) throw options.commitError;
      },
      rollback: async () => {
        rollbacks += 1;
        options.events?.push("rollback");
      },
    },
    commits: () => commits,
    rollbacks: () => rollbacks,
  };
}

describe("Google auth CLI", () => {
  it("routes Drive status JSON through the injected output", async () => {
    const { configFile, config } = await configFixture();
    config.drive.rootFolderId = "root-1";
    config.drive.accountEmail = "person@example.com";
    await writeConfig(configFile, config);
    const output: string[] = [];

    await runCli(
      [
        "node",
        "brain-mcp",
        "--config",
        configFile,
        "drive",
        "status",
        "--json",
      ],
      { writeOutput: (value) => output.push(value) },
    );

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual({
      configured: true,
      rootFolderId: "root-1",
      accountEmail: "person@example.com",
    });
  });

  it("guides account selection and persists the selected account/root", async () => {
    const { configFile } = await configFixture();
    const output: string[] = [];
    const events: string[] = [];
    const secrets = new MemorySecretStore("old-credential");
    const staged = stagedAuthorization({ events });
    let beginCalls = 0;

    await runCli(
      ["node", "brain-mcp", "--config", configFile, "auth", "login", "--json"],
      {
        writeOutput: (value) => output.push(value),
        secretStoreFactory: () => secrets,
        oauthFactory: () => ({
          beginInteractiveAuthorization: async () => {
            beginCalls += 1;
            return staged.session;
          },
          getClient: async () => staged.session.client,
        }),
        driveFactory: (auth) => {
          expect(auth).toBe(staged.session.client);
          return connectedDrive() as never;
        },
        writeConfig: async (path, config) => {
          events.push("write-config");
          await writeConfig(path, config);
        },
      },
    );

    expect(beginCalls).toBe(1);
    expect(events).toEqual(["commit", "write-config"]);
    expect(staged.rollbacks()).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual({
      authenticated: true,
      account: { email: "person@example.com", displayName: "Person" },
      drive: { rootFolderId: "root-1", rootFolderName: "brain-hub" },
    });
    const persisted = await loadConfig({
      homeDir: "/unused",
      hostname: "unused",
      platform: process.platform,
      configFile,
      env: {},
    });
    expect(persisted.config.drive).toMatchObject({
      accountEmail: "person@example.com",
      accountPermissionId: "permission-1",
      rootFolderId: "root-1",
    });
  });

  it("prints browser/account guidance only in text mode", async () => {
    const { configFile } = await configFixture();
    const output: string[] = [];
    const staged = stagedAuthorization();

    await runCli(
      ["node", "brain-mcp", "--config", configFile, "auth", "login"],
      {
        writeOutput: (value) => output.push(value),
        secretStoreFactory: () => new MemorySecretStore(null),
        oauthFactory: () => ({
          beginInteractiveAuthorization: async () => staged.session,
          getClient: async () => staged.session.client,
        }),
        driveFactory: () => connectedDrive() as never,
      },
    );

    expect(output).toHaveLength(2);
    expect(output[0]).toMatch(/browser.*Google account/is);
    expect(JSON.parse(output[1]!)).toMatchObject({ authenticated: true });
  });

  it("rolls back without committing when Drive identity is incomplete", async () => {
    const { configFile } = await configFixture();
    const staged = stagedAuthorization();
    let writes = 0;

    await expect(
      runCli(
        [
          "node",
          "brain-mcp",
          "--config",
          configFile,
          "auth",
          "login",
          "--json",
        ],
        {
          writeOutput: () => undefined,
          secretStoreFactory: () => new MemorySecretStore("old-credential"),
          oauthFactory: () => ({
            beginInteractiveAuthorization: async () => staged.session,
            getClient: async () => staged.session.client,
          }),
          driveFactory: () => connectedDrive({ permissionId: "" }) as never,
          writeConfig: async () => {
            writes += 1;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_UNAVAILABLE" });
    expect(staged.commits()).toBe(0);
    expect(staged.rollbacks()).toBe(1);
    expect(writes).toBe(0);
  });

  it("rolls back and skips config when credential commit fails", async () => {
    const { configFile } = await configFixture();
    const staged = stagedAuthorization({
      commitError: new Error("credential commit failed"),
    });
    let writes = 0;

    await expect(
      runCli(
        [
          "node",
          "brain-mcp",
          "--config",
          configFile,
          "auth",
          "login",
          "--json",
        ],
        {
          writeOutput: () => undefined,
          secretStoreFactory: () => new MemorySecretStore("old-credential"),
          oauthFactory: () => ({
            beginInteractiveAuthorization: async () => staged.session,
            getClient: async () => staged.session.client,
          }),
          driveFactory: () => connectedDrive() as never,
          writeConfig: async () => {
            writes += 1;
          },
        },
      ),
    ).rejects.toThrow(/credential commit failed/);
    expect(staged.commits()).toBe(1);
    expect(staged.rollbacks()).toBe(1);
    expect(writes).toBe(0);
  });

  it("rolls back the credential when config persistence fails", async () => {
    const { configFile } = await configFixture();
    const events: string[] = [];
    const staged = stagedAuthorization({ events });

    await expect(
      runCli(
        [
          "node",
          "brain-mcp",
          "--config",
          configFile,
          "auth",
          "login",
          "--json",
        ],
        {
          writeOutput: () => undefined,
          secretStoreFactory: () => new MemorySecretStore("old-credential"),
          oauthFactory: () => ({
            beginInteractiveAuthorization: async () => staged.session,
            getClient: async () => staged.session.client,
          }),
          driveFactory: () => connectedDrive() as never,
          writeConfig: async () => {
            events.push("write-config");
            throw new Error("config write failed");
          },
        },
      ),
    ).rejects.toThrow(/config write failed/);
    expect(events).toEqual(["commit", "write-config", "rollback"]);
  });

  it("reports the live authenticated account and configured match", async () => {
    const { configFile, config } = await configFixture();
    config.drive.rootFolderId = "root-1";
    config.drive.accountEmail = "person@example.com";
    config.drive.accountDisplayName = "Person";
    config.drive.accountPermissionId = "permission-1";
    await writeConfig(configFile, config);
    const output: string[] = [];
    const authClient = { marker: "stored-account" } as never;

    await runCli(
      ["node", "brain-mcp", "--config", configFile, "auth", "status", "--json"],
      {
        writeOutput: (value) => output.push(value),
        secretStoreFactory: () => new MemorySecretStore("stored-credential"),
        oauthFactory: () => ({
          beginInteractiveAuthorization: async () => {
            throw new Error("must not open interactive login");
          },
          getClient: async () => authClient,
        }),
        driveFactory: (received) => {
          expect(received).toBe(authClient);
          return connectedDrive() as never;
        },
      },
    );

    expect(JSON.parse(output[0]!)).toMatchObject({
      authenticated: true,
      account: { email: "person@example.com", displayName: "Person" },
      configuredAccount: { email: "person@example.com" },
      identityMatches: true,
      drive: { configured: true, rootFolderId: "root-1" },
    });
  });

  it("reports a missing credential through the CLI status contract", async () => {
    const { configFile } = await configFixture();
    const output: string[] = [];

    await runCli(
      ["node", "brain-mcp", "--config", configFile, "auth", "status", "--json"],
      {
        writeOutput: (value) => output.push(value),
        secretStoreFactory: () => new MemorySecretStore(null),
        oauthFactory: () => {
          throw new Error("must not construct OAuth without a credential");
        },
      },
    );

    expect(JSON.parse(output[0]!)).toEqual({
      authenticated: false,
      reason: "missing_credential",
      drive: { configured: false, rootFolderName: "brain-hub" },
    });
  });

  it("does not clear config when credential deletion fails", async () => {
    const { configFile, config } = await configFixture();
    config.drive.rootFolderId = "old-root";
    config.drive.accountEmail = "old@example.com";
    config.drive.accountDisplayName = "Old";
    config.drive.accountPermissionId = "old-permission";
    await writeConfig(configFile, config);
    const secrets = new MemorySecretStore("old-credential");
    secrets.delete = async () => {
      throw new Error("Keychain unavailable");
    };
    let writes = 0;

    await expect(
      runCli(
        [
          "node",
          "brain-mcp",
          "--config",
          configFile,
          "auth",
          "logout",
          "--json",
        ],
        {
          writeOutput: () => undefined,
          secretStoreFactory: () => secrets,
          writeConfig: async () => {
            writes += 1;
          },
        },
      ),
    ).rejects.toThrow(/Keychain unavailable/);
    expect(writes).toBe(0);
    expect(secrets.value).toBe("old-credential");
  });

  it("restores the old credential when logout config persistence fails", async () => {
    const { configFile } = await configFixture();
    const secrets = new MemorySecretStore("old-credential");

    await expect(
      runCli(
        [
          "node",
          "brain-mcp",
          "--config",
          configFile,
          "auth",
          "logout",
          "--json",
        ],
        {
          writeOutput: () => undefined,
          secretStoreFactory: () => secrets,
          writeConfig: async () => {
            throw new Error("config write failed");
          },
        },
      ),
    ).rejects.toThrow(/config write failed/);
    expect(secrets.value).toBe("old-credential");
  });

  it("clears credential, account, and root on successful logout", async () => {
    const { configFile, config } = await configFixture();
    config.drive.rootFolderId = "old-root";
    config.drive.accountEmail = "old@example.com";
    config.drive.accountDisplayName = "Old";
    config.drive.accountPermissionId = "old-permission";
    await writeConfig(configFile, config);
    const secrets = new MemorySecretStore("old-credential");
    const output: string[] = [];

    await runCli(
      ["node", "brain-mcp", "--config", configFile, "auth", "logout", "--json"],
      {
        writeOutput: (value) => output.push(value),
        secretStoreFactory: () => secrets,
      },
    );

    expect(secrets.value).toBeNull();
    const persisted = await loadConfig({
      homeDir: "/unused",
      hostname: "unused",
      platform: process.platform,
      configFile,
      env: {},
    });
    expect(persisted.config.drive).toMatchObject({
      rootFolderId: "",
      accountEmail: "",
      accountDisplayName: "",
      accountPermissionId: "",
    });
    expect(JSON.parse(output[0]!)).toEqual({ authenticated: false });
  });

  it("records the actual account identity during legacy drive init", async () => {
    const { configFile } = await configFixture();
    const output: string[] = [];
    const authClient = { marker: "stored-account" } as never;

    await runCli(
      ["node", "brain-mcp", "--config", configFile, "drive", "init", "--json"],
      {
        writeOutput: (value) => output.push(value),
        secretStoreFactory: () => new MemorySecretStore("stored-credential"),
        oauthFactory: () => ({
          beginInteractiveAuthorization: async () => {
            throw new Error("must not open interactive login");
          },
          getClient: async () => authClient,
        }),
        driveFactory: () => connectedDrive() as never,
      },
    );

    expect(JSON.parse(output[0]!)).toEqual({
      initialized: true,
      account: { email: "person@example.com", displayName: "Person" },
      rootFolderId: "root-1",
    });
    const persisted = await loadConfig({
      homeDir: "/unused",
      hostname: "unused",
      platform: process.platform,
      configFile,
      env: {},
    });
    expect(persisted.config.drive).toMatchObject({
      rootFolderId: "root-1",
      accountEmail: "person@example.com",
      accountPermissionId: "permission-1",
    });
  });
});
