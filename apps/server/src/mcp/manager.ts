import type { McpServerState, WorkspaceMcpConfig } from "@picone/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

interface Connection {
  name: string;
  client: Client;
  tools: ToolDefinition[];
  error?: string;
}

/**
 * MCP servers belong to the workspace, not to a repository (DESIGN §32).
 * Their tools are handed to Pi as ordinary custom tools.
 */
export class McpManager {
  private connections = new Map<string, Connection>();
  private disabled = new Map<string, string>();

  /** Connect every enabled server. Failures are reported, never fatal. */
  async start(config: Record<string, WorkspaceMcpConfig> | undefined): Promise<void> {
    await this.stop();
    if (!config) return;

    const entries = Object.entries(config);
    await Promise.all(
      entries.map(async ([name, cfg]) => {
        if (cfg.enabled === false) {
          this.disabled.set(name, "disabled");
          return;
        }
        try {
          const connection = await this.connect(name, cfg);
          this.connections.set(name, connection);
        } catch (err) {
          this.connections.set(name, {
            name,
            client: null as unknown as Client,
            tools: [],
            error: (err as Error).message,
          });
        }
      }),
    );
  }

  async stop(): Promise<void> {
    const closing = [...this.connections.values()].map(async (c) => {
      try {
        await c.client?.close();
      } catch {
        /* already gone */
      }
    });
    this.connections.clear();
    this.disabled.clear();
    await Promise.all(closing);
  }

  tools(): ToolDefinition[] {
    return [...this.connections.values()].flatMap((c) => c.tools);
  }

  state(): McpServerState[] {
    const out: McpServerState[] = [];
    for (const [name, reason] of this.disabled) {
      out.push({ name, enabled: false, status: "disabled", toolCount: 0, error: reason === "disabled" ? undefined : reason });
    }
    for (const [name, conn] of this.connections) {
      out.push({
        name,
        enabled: true,
        status: conn.error ? "error" : "connected",
        toolCount: conn.tools.length,
        error: conn.error,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async connect(name: string, cfg: WorkspaceMcpConfig): Promise<Connection> {
    const client = new Client({ name: "picone", version: "0.1.0" }, { capabilities: {} });

    if (cfg.url) {
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      });
      await client.connect(transport);
    } else if (cfg.command) {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
        stderr: "ignore",
      });
      await client.connect(transport);
    } else {
      throw new Error(`MCP server "${name}" has neither "command" nor "url"`);
    }

    const { tools } = await client.listTools();
    const definitions = tools.map((tool) =>
      defineTool({
        name: qualifiedName(name, tool.name),
        label: `${name}: ${tool.name}`,
        description: tool.description ?? `${tool.name} (via MCP server ${name})`,
        parameters: toTypebox(tool.inputSchema),
        execute: async (_id, params) => {
          const result = await client.callTool({ name: tool.name, arguments: params as Record<string, unknown> });
          const content = Array.isArray(result.content) ? result.content : [];
          const text = content
            .map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
            .join("\n");
          if (result.isError) throw new Error(text || `MCP tool ${tool.name} failed`);
          return { content: [{ type: "text", text: text || "(no output)" }], details: result };
        },
      }),
    );

    return { name, client, tools: definitions };
  }
}

function qualifiedName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * MCP publishes plain JSON Schema; Pi wants a typebox schema. Typebox schemas
 * are JSON Schema objects at runtime, so an `Unsafe` wrapper preserves the
 * server's schema verbatim while satisfying the type contract.
 */
function toTypebox(schema: unknown): TSchema {
  if (!schema || typeof schema !== "object") return Type.Object({});
  const s = schema as Record<string, unknown>;
  if (s.type !== "object") return Type.Object({});
  return Type.Unsafe<Record<string, unknown>>({
    type: "object",
    properties: (s.properties as Record<string, unknown>) ?? {},
    required: (s.required as string[]) ?? [],
    ...(s.additionalProperties !== undefined ? { additionalProperties: s.additionalProperties } : {}),
  });
}
