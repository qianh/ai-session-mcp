import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { SessionSourceSchema, type SessionSource } from "../domain/session.js";

interface RuntimeServices {
  uploadSessions(input: {
    sources?: SessionSource[];
    backfill?: boolean;
    includeSubagents?: boolean;
    dryRun?: boolean;
  }): Promise<object>;
  searchSessions(input: {
    query: string;
    from?: string;
    to?: string;
    sources?: string[];
    limit?: number;
  }): Promise<object>;
  getSession(input: {
    source: SessionSource;
    conversationId: string;
  }): Promise<object>;
  getPortrait(): Promise<object>;
  hubStatus(): Promise<object>;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function success(output: object, text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: output as Record<string, unknown>,
  };
}

function failure(error: unknown): ToolResult {
  const candidate = error as { code?: unknown; message?: unknown };
  const code =
    typeof candidate.code === "string" ? candidate.code : "INTERNAL_ERROR";
  const message =
    typeof candidate.message === "string"
      ? candidate.message
      : "BrainHub operation failed";
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}

export function createToolHandlers(services: RuntimeServices) {
  return {
    upload_sessions: async (input: {
      sources?: SessionSource[] | undefined;
      backfill?: boolean | undefined;
      include_subagents?: boolean | undefined;
      dry_run?: boolean | undefined;
    }): Promise<ToolResult> => {
      try {
        const output = await services.uploadSessions({
          ...(input.sources ? { sources: input.sources } : {}),
          ...(input.backfill !== undefined ? { backfill: input.backfill } : {}),
          ...(input.include_subagents !== undefined
            ? { includeSubagents: input.include_subagents }
            : {}),
          ...(input.dry_run !== undefined ? { dryRun: input.dry_run } : {}),
        });
        const scanned = (output as { scanned?: number }).scanned ?? 0;
        const uploaded = (output as { uploaded?: number }).uploaded ?? 0;
        return success(
          output,
          `BrainHub 扫描 ${scanned} 个会话，上传 ${uploaded} 个。`,
        );
      } catch (error) {
        return failure(error);
      }
    },
    search_sessions: async (input: {
      query: string;
      from?: string | undefined;
      to?: string | undefined;
      sources?: string[] | undefined;
      limit?: number | undefined;
    }): Promise<ToolResult> => {
      try {
        const output = await services.searchSessions({
          query: input.query,
          ...(input.from ? { from: input.from } : {}),
          ...(input.to ? { to: input.to } : {}),
          ...(input.sources ? { sources: input.sources } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        return success(output, JSON.stringify(output, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
    get_portrait: async (): Promise<ToolResult> => {
      try {
        const output = await services.getPortrait();
        return success(
          output,
          (output as { portrait?: string }).portrait ?? "画像不可用",
        );
      } catch (error) {
        return failure(error);
      }
    },
    get_session: async (input: {
      source: SessionSource;
      conversation_id: string;
    }): Promise<ToolResult> => {
      try {
        const output = await services.getSession({
          source: input.source,
          conversationId: input.conversation_id,
        });
        return success(
          output,
          (output as { content?: string }).content ?? "会话不可用",
        );
      } catch (error) {
        return failure(error);
      }
    },
    hub_status: async (): Promise<ToolResult> => {
      try {
        const output = await services.hubStatus();
        return success(output, JSON.stringify(output, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createMcpServer(services: RuntimeServices): McpServer {
  const server = new McpServer({ name: "brainhub-mcp", version: "0.4.1" });
  const handlers = createToolHandlers(services);
  const source = SessionSourceSchema;

  server.registerTool(
    "upload_sessions",
    {
      description: "扫描、脱敏并增量上传本机 AI 编程会话到 BrainHub",
      inputSchema: {
        sources: z.array(source).optional(),
        backfill: z.boolean().optional(),
        include_subagents: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      },
    },
    handlers.upload_sessions,
  );
  server.registerTool(
    "search_sessions",
    {
      description: "搜索 BrainHub inbox 中的 AI 编程会话",
      inputSchema: {
        query: z.string().min(1),
        from: z.string().optional(),
        to: z.string().optional(),
        sources: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    handlers.search_sessions,
  );
  server.registerTool(
    "get_portrait",
    {
      description: "读取配置的 Google Drive 目录和文件中的完整画像",
      inputSchema: {},
    },
    handlers.get_portrait,
  );
  server.registerTool(
    "get_session",
    {
      description: "根据搜索返回的来源和会话标识读取 inbox 中的完整会话",
      inputSchema: {
        source,
        conversation_id: z.string().min(1),
      },
    },
    handlers.get_session,
  );
  server.registerTool(
    "hub_status",
    {
      description: "读取 BrainHub 账号、上传、搜索索引和定时任务状态",
      inputSchema: {},
    },
    handlers.hub_status,
  );
  return server;
}

export async function serveMcp(services: RuntimeServices): Promise<void> {
  const server = createMcpServer(services);
  await server.connect(new StdioServerTransport());
}
