import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  install: vi.fn().mockResolvedValue({ installed: ["codex"], warnings: [] }),
  serve: vi.fn().mockResolvedValue(undefined),
  runtime: vi.fn(),
}));

vi.mock("../../src/clients/auto-install.js", () => ({
  installLocalIntegrations: mocks.install,
}));
vi.mock("../../src/runtime/container.js", () => ({
  BrainHubRuntime: class {
    constructor() {
      mocks.runtime();
    }
  },
}));
vi.mock("../../src/mcp/server.js", () => ({ serveMcp: mocks.serve }));

import { runCli } from "../../src/cli/index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("MCP startup onboarding", () => {
  it("installs only local skills before starting MCP without stdout output", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runCli(["node", "brainhub-mcp", "serve"]);

    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({
        skillsOnly: true,
        launch: {
          command: process.execPath,
          args: [expect.stringMatching(/brainhub-mcp$/)],
        },
      }),
    );
    expect(mocks.install.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.serve.mock.invocationCallOrder[0]!,
    );
    expect(mocks.serve).toHaveBeenCalledOnce();
    expect(output).not.toHaveBeenCalled();
  });

  it("reports skill installation warnings on stderr and still starts MCP", async () => {
    mocks.install.mockResolvedValueOnce({
      installed: [],
      warnings: ["codex: permission denied"],
    });
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await runCli(["node", "brainhub-mcp", "serve"]);

    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("codex: permission denied"),
    );
    expect(mocks.serve).toHaveBeenCalledOnce();
    expect(output).not.toHaveBeenCalled();
  });
});
