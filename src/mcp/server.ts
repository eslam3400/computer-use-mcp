import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { safeEqual } from "../util.js";
import type { AppConfig } from "../config.js";
import { toolDefs } from "./tooldefs.js";
import type { ToolRouter } from "./router.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "vps-coding-mcp", version: "1.0.0" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpServerDeps {
  cfgProvider: () => AppConfig;
  router: ToolRouter;
}

export function startMcpServer(deps: McpServerDeps): Server {
  return createServer((req, res) => {
    void handleRequest(req, res, deps);
  });
}

function unauthorized(res: ServerResponse, msg = "Missing or invalid bearer token"): void {
  res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
  res.end(JSON.stringify({ error: "unauthorized", message: msg }));
}

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: McpServerDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, server: SERVER_INFO.name, version: SERVER_INFO.version });
    return;
  }

  if (url.pathname !== "/mcp") {
    json(res, 404, { error: "not_found" });
    return;
  }

  // Bearer auth on every MCP request (plan safety rule).
  const cfg = deps.cfgProvider();
  const auth = req.headers.authorization ?? "";
  const expected = `Bearer ${cfg.mcpBearerToken}`;
  if (!auth.startsWith("Bearer ") || req.method !== "POST" || !safeEqual(auth, expected)) {
    unauthorized(res, req.method !== "POST" ? "MCP endpoint only accepts POST" : undefined);
    return;
  }
  const mcpVersion = req.headers["mcp-protocol-version"];
  if (typeof mcpVersion === "string" && mcpVersion && mcpVersion !== PROTOCOL_VERSION) {
    // Header is advisory for us; we always answer with our supported version.
    void mcpVersion;
  }

  let body = "";
  for await (const chunk of req) body += chunk;
  if (body.length > 8 * 1024 * 1024) {
    json(res, 413, { error: "payload_too_large" });
    return;
  }

  let message: JsonRpcRequest;
  try {
    message = JSON.parse(body) as JsonRpcRequest;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    return;
  }

  // Notifications (no id): accept and return 202 per Streamable HTTP.
  if (message.id === undefined || message.id === null) {
    res.writeHead(202).end();
    return;
  }

  try {
    const result = await dispatch(message, deps);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result,
      })
    );
  } catch (e) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: (e as Error).message ?? "internal error" },
      })
    );
  }
}

async function dispatch(message: JsonRpcRequest, deps: McpServerDeps): Promise<unknown> {
  switch (message.method) {
    case "initialize": {
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "VPS coding MCP: run OpenCode coding jobs against configured checkouts. Flow: list_workspaces -> submit_job -> get_job (poll; quiet until done/failed/needs_decision) -> get_diff -> ask user finish mode -> finish_job.",
      };
    }
    case "ping":
      return {};
    case "tools/list": {
      return { tools: toolDefs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
    }
    case "tools/call": {
      const name = String(message.params?.name);
      const toolArgs = message.params?.arguments ?? {};
      const out = await deps.router.call(name, toolArgs);
      return {
        content: [{ type: "text", text: out.text, ...(out.isError ? {} : {}) }],
        ...(out.isError ? { isError: true } : {}),
      };
    }
    case "resources/list":
      return { resources: [] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      throw new Error(`Method not found: ${message.method}`);
  }
}
