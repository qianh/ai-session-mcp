import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createMcpServer } from "../../src/mcp/server.js";

describe("MCP protocol", () => {
  it("negotiates and publishes the five validated tools", async () => {
    const services = {
      uploadSessions: async () => ({ dryRun: true, scanned: 0 }),
      searchSessions: async () => ({
        query: "test",
        indexStatus: "fresh",
        results: [],
        warnings: [],
      }),
      getPortrait: async () => ({ portrait: "profile" }),
      pullPortrait: async () => ({ portrait: "profile" }),
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
        "hub_status",
        "pull_portrait",
        "search_sessions",
        "upload_sessions",
      ]);
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
    } finally {
      await client.close();
      await server.close();
    }
  });
});
