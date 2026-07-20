import { describe, expect, it } from "vitest";

import { resolveGoogleAccountStatus } from "../../src/auth/account-status.js";
import { createDefaultConfig } from "../../src/domain/config.js";

function config() {
  return createDefaultConfig({
    hostname: "test-device",
    homeDir: "/home/test",
    platform: "linux",
  });
}

describe("Google account status", () => {
  it("reports a missing credential without validating Google", async () => {
    let validationCalls = 0;
    const result = await resolveGoogleAccountStatus({
      config: config(),
      credential: null,
      loadAccount: async () => {
        validationCalls += 1;
        throw new Error("must not validate");
      },
    });

    expect(result).toEqual({
      authenticated: false,
      reason: "missing_credential",
      drive: { configured: false, rootFolderName: "brain-hub" },
    });
    expect(validationCalls).toBe(0);
  });

  it("reports an invalid stored credential without leaking its error", async () => {
    const connected = config();
    connected.drive.rootFolderId = "root-1";
    connected.drive.accountEmail = "configured@example.com";
    connected.drive.accountDisplayName = "Configured";
    connected.drive.accountPermissionId = "permission-1";

    await expect(
      resolveGoogleAccountStatus({
        config: connected,
        credential: "sensitive-token",
        loadAccount: async () => {
          throw new Error("token payload must not leak");
        },
      }),
    ).resolves.toEqual({
      authenticated: false,
      reason: "invalid_credential",
      configuredAccount: {
        email: "configured@example.com",
        displayName: "Configured",
      },
      drive: {
        configured: true,
        rootFolderId: "root-1",
        rootFolderName: "brain-hub",
      },
    });
  });

  it("reports the live account and a matching configured identity", async () => {
    const connected = config();
    connected.drive.rootFolderId = "root-1";
    connected.drive.accountEmail = "person@example.com";
    connected.drive.accountDisplayName = "Person";
    connected.drive.accountPermissionId = "permission-1";

    await expect(
      resolveGoogleAccountStatus({
        config: connected,
        credential: "stored-token",
        loadAccount: async () => ({
          email: "person@example.com",
          displayName: "Person",
          permissionId: "permission-1",
        }),
      }),
    ).resolves.toEqual({
      authenticated: true,
      account: { email: "person@example.com", displayName: "Person" },
      configuredAccount: {
        email: "person@example.com",
        displayName: "Person",
      },
      identityMatches: true,
      drive: {
        configured: true,
        rootFolderId: "root-1",
        rootFolderName: "brain-hub",
      },
    });
  });

  it("keeps authentication valid while flagging an identity mismatch", async () => {
    const connected = config();
    connected.drive.accountEmail = "old@example.com";
    connected.drive.accountDisplayName = "Old Account";
    connected.drive.accountPermissionId = "old-permission";

    const result = await resolveGoogleAccountStatus({
      config: connected,
      credential: "stored-token",
      loadAccount: async () => ({
        email: "new@example.com",
        displayName: "New Account",
        permissionId: "new-permission",
      }),
    });

    expect(result).toMatchObject({
      authenticated: true,
      identityMatches: false,
      account: { email: "new@example.com" },
      configuredAccount: { email: "old@example.com" },
    });
  });
});
