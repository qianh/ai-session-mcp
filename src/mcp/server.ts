import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { SessionSource } from "../domain/session.js";

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
  getPortrait(): Promise<object>;
  pullPortrait(): Promise<object>;
  hubStatus(): Promise<object>;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function success(output: object, text: string): ToolResult {
  return {
    content: [{ type: "text", text: text.slice(0, 65_000) }],
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
      include_original?: boolean | undefined;
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
    pull_portrait: async (): Promise<ToolResult> => {
      try {
        const output = await services.pullPortrait();
        return success(
          output,
          (output as { diff?: string }).diff ??
            "画像已更新，本期没有 Diff 段落。",
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
  const server = new McpServer({ name: "brain-mcp", version: "0.1.0" });
  const handlers = createToolHandlers(services);
  const source = z.enum(["claude-code", "codex", "grok-build"]);

  server.registerTool(
    "upload_sessions",
    {
      description: "扫描、脱敏并增量上传本机 AI CLI 会话到 BrainHub",
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
      description: "对 BrainHub cards、sessions 和 inbox 执行混合语义搜索",
      inputSchema: {
        query: z.string().min(1),
        from: z.string().optional(),
        to: z.string().optional(),
        sources: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        include_original: z.boolean().optional(),
      },
    },
    handlers.search_sessions,
  );
  server.registerTool(
    "get_portrait",
    {
      description: "读取 Drive 最新画像并尝试刷新本地 Obsidian 副本",
      inputSchema: {},
    },
    handlers.get_portrait,
  );
  server.registerTool(
    "pull_portrait",
    {
      description: "将画像和最新周报原子写入 Obsidian，并返回 Diff",
      inputSchema: {},
    },
    handlers.pull_portrait,
  );
  server.registerTool(
    "hub_status",
    {
      description: "读取 BrainHub 配额、积压、蒸馏和本地适配器状态",
      inputSchema: { include_local: z.boolean().optional().default(true) },
    },
    handlers.hub_status,
  );
  return server;
}

export async function serveMcp(services: RuntimeServices): Promise<void> {
  const server = createMcpServer(services);
  await server.connect(new StdioServerTransport());
}
