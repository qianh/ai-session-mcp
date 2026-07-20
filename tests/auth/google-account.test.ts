import { describe, expect, it } from "vitest";

import {
  applyGoogleConnection,
  clearGoogleConnection,
  connectGoogleAccount,
} from "../../src/auth/google-account.js";
import { createDefaultConfig } from "../../src/domain/config.js";

describe("Google account binding", () => {
  it("applies and clears an account/root binding immutably", () => {
    const config = createDefaultConfig({
      hostname: "test-device",
      homeDir: "/home/test",
      platform: "linux",
    });
    const connected = applyGoogleConnection(config, {
      account: {
        email: "person@example.com",
        displayName: "Person",
        permissionId: "permission-1",
      },
      rootFolderId: "root-1",
    });

    expect(connected).not.toBe(config);
    expect(connected.drive).toMatchObject({
      rootFolderId: "root-1",
      accountEmail: "person@example.com",
      accountDisplayName: "Person",
      accountPermissionId: "permission-1",
    });
    expect(config.drive.rootFolderId).toBe("");

    const cleared = clearGoogleConnection(connected);
    expect(cleared.drive).toMatchObject({
      rootFolderId: "",
      accountEmail: "",
      accountDisplayName: "",
      accountPermissionId: "",
    });
    expect(connected.drive.rootFolderId).toBe("root-1");
  });

  it("reads identity and binds a root through the newly authorized client", async () => {
    const authClient = { marker: "new-account" };
    let receivedAuth: unknown;
    const drive = {
      about: {
        get: async () => ({
          data: {
            user: {
              emailAddress: "person@example.com",
              displayName: "Person",
              permissionId: "permission-1",
            },
          },
        }),
      },
      files: {
        list: async () => ({ data: { files: [{ id: "existing-root" }] } }),
        create: async () => {
          throw new Error("must reuse existing root");
        },
      },
    };

    const connection = await connectGoogleAccount({
      authClient: authClient as never,
      drive: (auth) => {
        receivedAuth = auth;
        return drive as never;
      },
      rootFolderName: "brain-hub",
    });

    expect(receivedAuth).toBe(authClient);
    expect(connection).toEqual({
      account: {
        email: "person@example.com",
        displayName: "Person",
        permissionId: "permission-1",
      },
      rootFolderId: "existing-root",
    });
  });

  it("rejects incomplete identity before touching root folders", async () => {
    let rootCalls = 0;
    const drive = {
      about: {
        get: async () => ({
          data: {
            user: {
              emailAddress: "person@example.com",
              displayName: "Person",
            },
          },
        }),
      },
      files: {
        list: async () => {
          rootCalls += 1;
          return { data: { files: [] } };
        },
      },
    };

    await expect(
      connectGoogleAccount({
        authClient: {} as never,
        drive: () => drive as never,
        rootFolderName: "brain-hub",
      }),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_UNAVAILABLE" });
    expect(rootCalls).toBe(0);
  });

  it("does not turn a root creation failure into a connection", async () => {
    const drive = {
      about: {
        get: async () => ({
          data: {
            user: {
              emailAddress: "person@example.com",
              displayName: "Person",
              permissionId: "permission-1",
            },
          },
        }),
      },
      files: {
        list: async () => ({ data: { files: [] } }),
        create: async () => {
          throw new Error("root create failed");
        },
      },
    };

    await expect(
      connectGoogleAccount({
        authClient: {} as never,
        drive: () => drive as never,
        rootFolderName: "brain-hub",
      }),
    ).rejects.toThrow(/root create failed/);
  });
});
