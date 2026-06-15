import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { IncomingMessage, ServerResponse, createServer } from 'http';
import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';

import { DestinyAPI } from './destiny-api.js';
import { BungieAuth } from './auth.js';
import { ManifestManager } from './manifest.js';
import { InventoryCache } from './inventory.js';
import { WebSocketServerTransport } from './websocket-transport.js';
import { loadConfig } from './config.js';
import { allTools, toolMap, ToolContext } from './tools/index.js';

export function buildContext(): ToolContext {
  const config = loadConfig();
  const auth = new BungieAuth(config);
  const api = new DestinyAPI(config, auth);
  const manifest = new ManifestManager(api, config);
  const inventory = new InventoryCache(api, manifest, auth, config);
  return { api, auth, manifest, inventory };
}

export function createMCPServer(ctx: ToolContext = buildContext()) {
  const server = new Server({ name: 'd2-mcp', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = toolMap.get(name);
    if (!entry) return errorResult(`Unknown tool: ${name}`);
    try {
      const result = await entry.handler(ctx, args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}

export async function runStdioServer() {
  const ctx = buildContext();
  ctx.inventory.startAutoRefresh();
  const server = createMCPServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`d2-mcp running on stdio (${allTools.length} tools)`);
}

/**
 * Long-running HTTP server exposing two transports on one port:
 *   - POST/GET/DELETE /mcp  → Streamable HTTP (the modern MCP transport)
 *   - WebSocket upgrade     → legacy WebSocket transport
 *   - GET /                 → plain-text health/info
 *
 * If D2_MCP_AUTH_TOKEN is set, both transports require `Authorization: Bearer <token>`.
 */
export async function runHttpServer(port = 3000) {
  const ctx = buildContext();
  ctx.inventory.startAutoRefresh();
  const authToken = process.env.D2_MCP_AUTH_TOKEN || undefined;

  // Streamable HTTP keeps one transport per initialized session.
  const sessions: Record<string, StreamableHTTPServerTransport> = {};

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (url.pathname === '/mcp') {
      void handleMcp(req, res);
    } else if (url.pathname === '/' || url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          name: 'd2-mcp',
          version: '2.0.0',
          tools: allTools.length,
          transports: { streamableHttp: '/mcp', webSocket: `ws://<host>:${port}` },
          authRequired: Boolean(authToken),
        })
      );
    } else {
      res.writeHead(404).end('Not found');
    }
  });

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    if (!authorized(req, authToken)) return sendJsonError(res, 401, -32001, 'Unauthorized');

    try {
      if (req.method === 'POST') {
        const body = await readJson(req);
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport = sessionId ? sessions[sessionId] : undefined;

        if (!transport && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              sessions[sid] = transport!;
            },
          });
          transport.onclose = () => {
            if (transport!.sessionId) delete sessions[transport!.sessionId];
          };
          await createMCPServer(ctx).connect(transport);
        } else if (!transport) {
          return sendJsonError(res, 400, -32000, 'No valid session ID for non-initialize request');
        }

        await transport.handleRequest(req, res, body);
      } else if (req.method === 'GET' || req.method === 'DELETE') {
        // GET opens the SSE notification stream; DELETE terminates the session.
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const transport = sessionId ? sessions[sessionId] : undefined;
        if (!transport) return sendJsonError(res, 400, -32000, 'Invalid or missing session ID');
        await transport.handleRequest(req, res);
      } else {
        res.writeHead(405).end('Method not allowed');
      }
    } catch (error) {
      if (!res.headersSent) {
        sendJsonError(res, 500, -32603, error instanceof Error ? error.message : String(error));
      }
    }
  }

  // WebSocket transport on the same port.
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    if (!authorized(req, authToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const transport = new WebSocketServerTransport(ws);
      createMCPServer(ctx)
        .connect(transport)
        .catch((error) => console.error('WebSocket connection error:', error));
    });
  });

  httpServer.listen(port, () => {
    console.error(
      `d2-mcp listening on port ${port} — Streamable HTTP at /mcp, WebSocket on the same port` +
        (authToken ? ' (auth required)' : '')
    );
  });

  return { httpServer, wss };
}

/** Backwards-compatible alias — the server now serves both /mcp and WebSocket. */
export const runWebSocketServer = runHttpServer;

// -- helpers --------------------------------------------------------------

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  return req.headers['authorization'] === `Bearer ${token}`;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJsonError(res: ServerResponse, status: number, code: number, message: string) {
  if (res.headersSent) return;
  res
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
