import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { createMcpServer } from "../../src/mcp/server.js";

describe("MCP protocol", () => {
  it("negotiates and publishes the five validated tools", async () => {
    const services = {
      uploadSessions: vi.fn(async () => ({ dryRun: true, scanned: 0 })),
      searchSessions: async () => ({
        query: "test",
        indexStatus: "fresh",
        results: [],
        warnings: [],
      }),
      getPortrait: async () => ({ portrait: "profile" }),
      getSession: vi.fn(async () => ({
        source: "cursor",
        conversationId: "cursor-1",
        content: "complete session",
      })),
      hubStatus: async () => ({ drive: { reachable: true } }),
    };
    const server = createMcpServer(services);
    const client = new Client({ name: "brainhub-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "get_portrait",
        "get_session",
        "hub_status",
        "search_sessions",
        "upload_sessions",
      ]);
      const sessionTool = tools.tools.find(
        (tool) => tool.name === "get_session",
      );
      expect(sessionTool?.inputSchema).toMatchObject({
        required: ["source", "conversation_id"],
      });
      const searchTool = tools.tools.find(
        (tool) => tool.name === "search_sessions",
      );
      expect(searchTool?.inputSchema.properties).not.toHaveProperty(
        "include_original",
      );
      const invalid = await client.callTool({
        name: "search_sessions",
        arguments: { query: "" },
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("Input validation error"),
          }),
        ]),
      );
      const upload = await client.callTool({
        name: "upload_sessions",
        arguments: { sources: ["cursor"], dry_run: true },
      });
      expect(upload.isError).not.toBe(true);
      expect(services.uploadSessions).toHaveBeenCalledWith(
        expect.objectContaining({ sources: ["cursor"], dryRun: true }),
      );
      const cursorSession = await client.callTool({
        name: "get_session",
        arguments: { source: "cursor", conversation_id: "cursor-1" },
      });
      expect(cursorSession.isError).not.toBe(true);
      expect(services.getSession).toHaveBeenCalledWith({
        source: "cursor",
        conversationId: "cursor-1",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
