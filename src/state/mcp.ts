import { C, terminalPrint } from "../core/util.js";

// MCP is modeled as late-bound tools: connect first, then discovered server
// tools are merged into the normal tool pool with mcp__server__tool names.

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

type Handler = (args: Record<string, any>) => string;

export class MCPClient {
  tools: ToolDef[] = [];
  private handlers = new Map<string, Handler>();

  constructor(public name: string) {}

  register(toolDefs: ToolDef[], handlers: Record<string, Handler>): void {
    this.tools = toolDefs;
    this.handlers = new Map(Object.entries(handlers));
  }

  callTool(toolName: string, args: Record<string, any>): string {
    const handler = this.handlers.get(toolName);
    if (!handler) return `MCP error: unknown tool '${toolName}'`;
    try {
      return handler(args);
    } catch (e: any) {
      return `MCP error: ${e.message}`;
    }
  }
}

export const mcpClients = new Map<string, MCPClient>();

const DISALLOWED = /[^a-zA-Z0-9_-]/g;
export function normalizeMcpName(name: string): string {
  return name.replace(DISALLOWED, "_");
}

function mockServerDocs(): MCPClient {
  const c = new MCPClient("docs");
  c.register(
    [
      {
        name: "search",
        description: "Search documentation. (readOnly)",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      {
        name: "get_version",
        description: "Get API version. (readOnly)",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ],
    {
      search: (a) => `[docs] Found 3 results for '${a.query}'`,
      get_version: () => "[docs] API v2.1.0",
    },
  );
  return c;
}

function mockServerDeploy(): MCPClient {
  const c = new MCPClient("deploy");
  c.register(
    [
      {
        name: "trigger",
        description: "Trigger a deployment. (destructive — requires approval in real CC)",
        inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] },
      },
      {
        name: "status",
        description: "Check deployment status. (readOnly)",
        inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] },
      },
    ],
    {
      trigger: (a) => `[deploy] Triggered: ${a.service}`,
      status: (a) => `[deploy] ${a.service}: running (v1.4.2)`,
    },
  );
  return c;
}

const MOCK_SERVERS: Record<string, () => MCPClient> = {
  docs: mockServerDocs,
  deploy: mockServerDeploy,
};

export function connectMcp(name: string): string {
  if (mcpClients.has(name)) return `MCP server '${name}' already connected`;
  const factory = MOCK_SERVERS[name];
  if (!factory) {
    const available = Object.keys(MOCK_SERVERS).join(", ");
    return `Unknown server '${name}'. Available: ${available}`;
  }
  const client = factory();
  mcpClients.set(name, client);
  const toolNames = client.tools.map((t) => t.name);
  terminalPrint(`  ${C.red}[mcp] connected: ${name} → ${toolNames.join(", ")}${C.reset}`);
  return `Connected to MCP server '${name}'. Discovered ${client.tools.length} tools: ${toolNames.join(", ")}`;
}
