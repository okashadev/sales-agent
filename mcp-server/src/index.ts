import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Pool } from "pg";
import { z } from "zod";
import { createPool } from "./db.js";
import { registerLeadTools } from "./tools/leads.js";

const HOST = "127.0.0.1";
const PORT = 3100;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const pool = createPool();
pool.on("error", (err) => console.error("[mcp-server] idle db client error:", err));
await pool.query("select 1"); // fail fast if the database or password is wrong

/** Fresh server per request: stateless mode must never share McpServer instances. */
function buildServer(db: Pool): McpServer {
  const server = new McpServer({ name: "hermes-sales-agent", version: "0.2.0" });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Health check: confirms the MCP server is reachable from Hermes",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ({
      content: [
        { type: "text", text: JSON.stringify({ status: "ok", version: "0.2.0", timestamp: new Date().toISOString() }) },
      ],
    }),
  );

  registerLeadTools(server, db);
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.headers.host || !ALLOWED_HOSTS.has(req.headers.host)) {
    return sendJson(res, 403, { error: "forbidden host" });
  }

  const path = req.url?.split("?")[0];

  if (path === "/health" && req.method === "GET") {
    return sendJson(res, 200, { status: "ok", port: PORT });
  }

  if (path === "/mcp") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    }

    const server = buildServer(pool);
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[mcp-server] request failed:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const httpServer = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[mcp-server] unhandled:", err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[mcp-server] listening on http://${HOST}:${PORT}/mcp`);
});

function shutdown(): void {
  console.log("\n[mcp-server] shutting down...");
  httpServer.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);