import { describe, expect, it, vi } from "vitest";

import { createToolHandlers } from "../../src/mcp/server.js";

describe("MCP tool handlers", () => {
  it("exposes all five tools as structured responses", async () => {
    const services = {
      uploadSessions: vi.fn(async () => ({
        dryRun: true,
        scanned: 2,
        warnings: [],
      })),
      searchSessions: vi.fn(async () => ({
        query: "release",
        indexStatus: "fresh",
        results: [],
        warnings: [],
      })),
      getPortrait: vi.fn(async () => ({
        portrait: "profile",
        localRefreshed: true,
        warnings: [],
      })),
      pullPortrait: vi.fn(async () => ({
        portrait: "profile",
        localRefreshed: true,
        warnings: [],
      })),
      hubStatus: vi.fn(async () => ({
        drive: { reachable: true },
        inbox: {},
        warnings: [],
      })),
    };
    const handlers = createToolHandlers(services as never);

    expect(Object.keys(handlers).sort()).toEqual([
      "get_portrait",
      "hub_status",
      "pull_portrait",
      "search_sessions",
      "upload_sessions",
    ]);
    const upload = await handlers.upload_sessions({ dry_run: true });
    expect(upload.structuredContent).toMatchObject({
      dryRun: true,
      scanned: 2,
    });
    expect(upload.content[0]?.text).toContain("2");
    await handlers.search_sessions({ query: "release", limit: 5 });
    expect(services.searchSessions).toHaveBeenCalledWith(
      expect.objectContaining({ query: "release", limit: 5 }),
    );
  });

  it("maps domain errors without leaking a stack", async () => {
    const services = {
      uploadSessions: async () => {
        throw Object.assign(new Error("login needed"), {
          code: "AUTH_REQUIRED",
        });
      },
      searchSessions: async () => ({}),
      getPortrait: async () => ({}),
      pullPortrait: async () => ({}),
      hubStatus: async () => ({}),
    };
    const result = await createToolHandlers(services as never).upload_sessions(
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "AUTH_REQUIRED", message: "login needed" },
    });
    expect(result.content[0]?.text).not.toContain("at ");
  });
});
