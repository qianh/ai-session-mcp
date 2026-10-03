import { describe, expect, it, vi } from "vitest";

import {
  UninstallService,
  brainHubDataDirectory,
  localCleanupTargets,
} from "../../src/setup/uninstall-service.js";

describe("complete uninstall", () => {
  it("resolves the full BrainHub data directory from account-scoped state", () => {
    expect(
      brainHubDataDirectory(
        "/Users/person/Library/Application Support/BrainHub/accounts/abc/state.sqlite",
      ),
    ).toBe("/Users/person/Library/Application Support/BrainHub");
  });

  it("never widens a custom model cache deletion to its parent", () => {
    expect(
      localCleanupTargets(
        "/Users/person/Library/Application Support/BrainHub/accounts/abc/state.sqlite",
        "/Users/person/Shared/brainhub-models",
      ),
    ).toEqual({
      dataDirectory: "/Users/person/Library/Application Support/BrainHub",
      modelCache: "/Users/person/Shared/brainhub-models",
    });
  });

  it("removes integrations, authorization, Keychain, and local state", async () => {
    const unregisterClient = vi.fn(async () => undefined);
    const uninstallClientSkills = vi.fn(async () => undefined);
    const uninstallScheduler = vi.fn(async () => undefined);
    const revokeGoogle = vi.fn(async () => true);
    const clearKeychain = vi.fn(async () => undefined);
    const removeLocalState = vi.fn(async () => undefined);
    const result = await new UninstallService({
      platform: "darwin",
      inspectClients: async () => ({
        claude: { available: true, registered: true },
        codex: { available: true, registered: false },
        grok: { available: true, registered: true },
        cursor: { available: true, registered: true },
      }),
      unregisterClient,
      uninstallClientSkills,
      uninstallScheduler,
      revokeGoogle,
      clearKeychain,
      removeLocalState,
    }).run();

    expect(unregisterClient.mock.calls).toEqual([
      ["claude"],
      ["grok"],
      ["cursor"],
    ]);
    expect(uninstallClientSkills).toHaveBeenCalledExactlyOnceWith("codex");
    expect(uninstallScheduler).toHaveBeenCalledOnce();
    expect(revokeGoogle).toHaveBeenCalledOnce();
    expect(clearKeychain).toHaveBeenCalledOnce();
    expect(removeLocalState).toHaveBeenCalledOnce();
    expect(result).toEqual({
      uninstalled: true,
      clients: ["claude", "grok", "cursor"],
      oauthRevoked: true,
      warnings: [],
    });
  });

  it("continues local cleanup when external revocation fails", async () => {
    const clearKeychain = vi.fn(async () => undefined);
    const removeLocalState = vi.fn(async () => undefined);
    const result = await new UninstallService({
      platform: "darwin",
      inspectClients: async () => ({
        claude: { available: false, registered: false },
        codex: { available: false, registered: false },
        grok: { available: false, registered: false },
        cursor: { available: false, registered: false },
      }),
      unregisterClient: async () => undefined,
      uninstallClientSkills: async () => undefined,
      uninstallScheduler: async () => {
        throw new Error("launchctl unavailable");
      },
      revokeGoogle: async () => {
        throw new Error("offline");
      },
      clearKeychain,
      removeLocalState,
    }).run();

    expect(clearKeychain).toHaveBeenCalledOnce();
    expect(removeLocalState).toHaveBeenCalledOnce();
    expect(result.uninstalled).toBe(true);
    expect(result.oauthRevoked).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "SCHEDULER_UNINSTALL_FAILED",
      "OAUTH_REVOCATION_FAILED",
    ]);
  });

  it("uninstalls on Linux and rejects Windows before cleanup", async () => {
    const uninstallScheduler = vi.fn(async () => undefined);
    const removeLocalState = vi.fn(async () => undefined);
    await expect(
      new UninstallService({
        platform: "linux",
        inspectClients: async () => ({
          claude: { available: false, registered: false },
          codex: { available: false, registered: false },
          grok: { available: false, registered: false },
          cursor: { available: false, registered: false },
        }),
        unregisterClient: async () => undefined,
        uninstallClientSkills: async () => undefined,
        uninstallScheduler,
        revokeGoogle: async () => false,
        clearKeychain: async () => undefined,
        removeLocalState,
      }).run(),
    ).resolves.toMatchObject({ uninstalled: true });
    expect(uninstallScheduler).toHaveBeenCalledOnce();
    expect(removeLocalState).toHaveBeenCalledOnce();

    const windowsCleanup = vi.fn(async () => undefined);
    await expect(
      new UninstallService({
        platform: "win32",
        inspectClients: async () => {
          throw new Error("must not inspect clients");
        },
        unregisterClient: async () => undefined,
        uninstallClientSkills: async () => undefined,
        uninstallScheduler: async () => undefined,
        revokeGoogle: async () => false,
        clearKeychain: async () => undefined,
        removeLocalState: windowsCleanup,
      }).run(),
    ).rejects.toMatchObject({ code: "PLATFORM_UNSUPPORTED" });
    expect(windowsCleanup).not.toHaveBeenCalled();
  });
});
