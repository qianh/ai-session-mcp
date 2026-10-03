import { describe, expect, it, vi } from "vitest";

import { SetupService } from "../../src/setup/setup-service.js";

describe("setup service", () => {
  it("runs a resumable default setup and keeps model failure non-blocking", async () => {
    const report = vi.fn();
    const runBackfill = vi.fn(async () => ({
      sessions: 3,
      bytes: 2048,
      confirmed: true,
      uploaded: 3,
      completed: true,
    }));
    const registerClient = vi.fn(async () => undefined);
    const installClientSkills = vi.fn(async () => undefined);
    const installScheduler = vi.fn(async () => undefined);
    const service = new SetupService({
      platform: "darwin",
      ensureConfig: async () => undefined,
      connectGoogle: async () => ({ email: "user@example.com" }),
      prepareModel: async (progress) => {
        progress({ percent: 25, file: "model.onnx" });
        throw new Error("download offline");
      },
      runBackfill,
      inspectClients: async () => ({
        claude: { available: true, registered: false },
        codex: { available: true, registered: true },
        grok: { available: false, registered: false },
        cursor: { available: true, registered: false },
      }),
      registerClient,
      installClientSkills,
      installScheduler,
      inspectObsidian: async () => ({ configured: false }),
      report,
    });

    const result = await service.run();

    expect(runBackfill).toHaveBeenCalledOnce();
    expect(registerClient.mock.calls).toEqual([["claude"], ["cursor"]]);
    expect(installClientSkills).toHaveBeenCalledExactlyOnceWith("codex");
    expect(installScheduler).toHaveBeenCalledExactlyOnceWith({
      portrait: false,
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ type: "model-progress", percent: 25 }),
    );
    expect(result).toMatchObject({
      account: { email: "user@example.com" },
      backfill: {
        sessions: 3,
        bytes: 2048,
        uploaded: 3,
        completed: true,
      },
      model: { ready: false },
      clients: { registered: ["claude", "cursor"] },
      scheduler: { installed: true },
      obsidian: { configured: false },
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "MODEL_DOWNLOAD_FAILED" }),
    );
  });

  it("installs portrait sync only when Obsidian is configured", async () => {
    const installScheduler = vi.fn(async () => undefined);
    const service = new SetupService({
      platform: "darwin",
      ensureConfig: async () => undefined,
      connectGoogle: async () => ({ email: "user@example.com" }),
      prepareModel: async () => undefined,
      runBackfill: async () => ({
        sessions: 0,
        bytes: 0,
        confirmed: true,
        uploaded: 0,
        completed: true,
      }),
      inspectClients: async () => ({
        claude: { available: false, registered: false },
        codex: { available: false, registered: false },
        grok: { available: false, registered: false },
        cursor: { available: false, registered: false },
      }),
      registerClient: async () => undefined,
      installClientSkills: async () => undefined,
      installScheduler,
      inspectObsidian: async () => ({
        configured: true,
        path: "/vault/BrainHub",
      }),
      report: () => undefined,
    });

    await service.run();

    expect(installScheduler).toHaveBeenCalledExactlyOnceWith({
      portrait: true,
    });
  });

  it("warns when accepted backfill still has retryable uploads", async () => {
    const service = new SetupService({
      platform: "darwin",
      ensureConfig: async () => undefined,
      connectGoogle: async () => ({ email: "user@example.com" }),
      prepareModel: async () => undefined,
      runBackfill: async () => ({
        sessions: 3,
        bytes: 2048,
        confirmed: true,
        uploaded: 2,
        completed: false,
      }),
      inspectClients: async () => ({
        claude: { available: false, registered: false },
        codex: { available: false, registered: false },
        grok: { available: false, registered: false },
        cursor: { available: false, registered: false },
      }),
      registerClient: async () => undefined,
      installClientSkills: async () => undefined,
      installScheduler: async () => undefined,
      inspectObsidian: async () => ({ configured: false }),
      report: () => undefined,
    });

    const result = await service.run();

    expect(result.backfill.completed).toBe(false);
    expect(result.warnings).toContainEqual({
      code: "BACKFILL_INCOMPLETE",
      message: "History backfill has retryable uploads remaining",
    });
  });

  it("probes the Linux secret store before writing setup state", async () => {
    const ensureSecretStore = vi.fn(async () => undefined);
    const ensureConfig = vi.fn(async () => undefined);
    const service = new SetupService({
      platform: "linux",
      ensureSecretStore,
      ensureConfig,
      connectGoogle: async () => ({ email: "user@example.com" }),
      prepareModel: async () => undefined,
      runBackfill: async () => ({
        sessions: 0,
        bytes: 0,
        confirmed: true,
        uploaded: 0,
        completed: true,
      }),
      inspectClients: async () => ({
        claude: { available: false, registered: false },
        codex: { available: false, registered: false },
        grok: { available: false, registered: false },
        cursor: { available: false, registered: false },
      }),
      registerClient: async () => undefined,
      installClientSkills: async () => undefined,
      installScheduler: async () => undefined,
      inspectObsidian: async () => ({ configured: false }),
      report: () => undefined,
    });

    await expect(service.run()).resolves.toMatchObject({
      account: { email: "user@example.com" },
      scheduler: { installed: true },
    });
    expect(ensureSecretStore).toHaveBeenCalledOnce();
    expect(ensureSecretStore.mock.invocationCallOrder[0]).toBeLessThan(
      ensureConfig.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("rejects setup on Windows before changing state", async () => {
    const ensureConfig = vi.fn(async () => undefined);
    const service = new SetupService({
      platform: "win32",
      ensureConfig,
      connectGoogle: async () => ({ email: "user@example.com" }),
      prepareModel: async () => undefined,
      runBackfill: async () => ({
        sessions: 0,
        bytes: 0,
        confirmed: true,
        uploaded: 0,
        completed: true,
      }),
      inspectClients: async () => ({
        claude: { available: false, registered: false },
        codex: { available: false, registered: false },
        grok: { available: false, registered: false },
        cursor: { available: false, registered: false },
      }),
      registerClient: async () => undefined,
      installClientSkills: async () => undefined,
      installScheduler: async () => undefined,
      inspectObsidian: async () => ({ configured: false }),
      report: () => undefined,
    });

    await expect(service.run()).rejects.toMatchObject({
      code: "PLATFORM_UNSUPPORTED",
    });
    expect(ensureConfig).not.toHaveBeenCalled();
  });
});
