import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { IncomingMessage, ServerResponse, createServer } from 'http';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { WebSocketServer } from 'ws';

import { DestinyAPI } from './destiny-api.js';
import { BungieAuth } from './auth.js';
import { ManifestManager } from './manifest.js';
import { InventoryCache } from './inventory.js';
import { ChecklistTracker } from './checklist-tracker.js';
import { WebSocketServerTransport } from './websocket-transport.js';
import { loadConfig } from './config.js';
import { allTools, toolMap, ToolContext } from './tools/index.js';
import { VERSION } from './version.js';

export function buildContext(): ToolContext {
  const config = loadConfig();
  const auth = new BungieAuth(config);
  const api = new DestinyAPI(config, auth);
  const manifest = new ManifestManager(api, config);
  const inventory = new InventoryCache(api, manifest, auth, config);
  const checklists = new ChecklistTracker(api, manifest, auth, inventory, config);
  return { api, auth, manifest, inventory, checklists };
}

export function createMCPServer(ctx: ToolContext = buildContext()) {
  const server = new Server(
    { name: 'destiny2', version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = toolMap.get(name);
    if (!entry) return errorResult(`Unknown tool: ${name}`);
    try {
      const result = await entry.handler(ctx, args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
  ctx.checklists.start();
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
export async function runHttpServer(
  port = 3000,
  opts: { ctx?: ToolContext; sessionIdleMs?: number; sweepMs?: number } = {}
) {
  const ctx = opts.ctx ?? buildContext();
  if (!opts.ctx) {
    ctx.inventory.startAutoRefresh();
    ctx.checklists.start();
  }
  const authToken = process.env.D2_MCP_AUTH_TOKEN || undefined;
  const sessionIdleMs =
    opts.sessionIdleMs ??
    Math.max(1, Number(process.env.D2_MCP_SESSION_IDLE_MINUTES) || 30) * 60_000;
  const allowedOrigins = new Set(
    (process.env.D2_MCP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  );

  // Streamable HTTP keeps one transport (+ Server) per initialized session.
  // Clients that vanish without DELETE would leak these, so sessions with no
  // open stream and no requests for `sessionIdleMs` are closed by a sweep.
  type Session = { transport: StreamableHTTPServerTransport; lastSeen: number; streams: number };
  const sessions = new Map<string, Session>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.streams === 0 && now - s.lastSeen > sessionIdleMs) void s.transport.close();
    }
  }, opts.sweepMs ?? 60_000);
  sweep.unref();

  /** Look up a session by header and mark it active for this request. */
  function touch(req: IncomingMessage, res: ServerResponse): Session | undefined {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (session) {
      session.lastSeen = Date.now();
      session.streams++;
      res.on('close', () => {
        session.streams--;
        session.lastSeen = Date.now();
      });
    }
    return session;
  }

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (url.pathname === '/mcp') {
      void handleMcp(req, res);
    } else if (url.pathname === '/' || url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          name: 'destiny2',
          version: VERSION,
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
    if (!originAllowed(req, allowedOrigins)) {
      return sendJsonError(res, 403, -32001, 'Forbidden origin');
    }
    if (!authorized(req, authToken)) return sendJsonError(res, 401, -32001, 'Unauthorized');

    try {
      if (req.method === 'POST') {
        const body = await readJson(req);
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport = touch(req, res)?.transport;

        if (!transport && isInitializeRequest(body)) {
          const created = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              sessions.set(sid, { transport: created, lastSeen: Date.now(), streams: 0 });
            },
          });
          created.onclose = () => {
            if (created.sessionId) sessions.delete(created.sessionId);
          };
          await createMCPServer(ctx).connect(created);
          transport = created;
        } else if (!transport) {
          return sessionNotFound(res, sessionId);
        }

        await transport.handleRequest(req, res, body);
      } else if (req.method === 'GET' || req.method === 'DELETE') {
        // GET opens the SSE notification stream; DELETE terminates the session.
        const transport = touch(req, res)?.transport;
        if (!transport) return sessionNotFound(res, req.headers['mcp-session-id']);
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
    if (!originAllowed(req, allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
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

  httpServer.on('close', () => clearInterval(sweep));
  return { httpServer, wss, sessions };
}

/** Backwards-compatible alias — the server now serves both /mcp and WebSocket. */
export const runWebSocketServer = runHttpServer;

// -- helpers --------------------------------------------------------------

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  // Compare fixed-length digests in constant time.
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(req.headers['authorization'] ?? ''), digest(`Bearer ${token}`));
}

/**
 * Block browser-originated requests. MCP clients don't send `Origin`; browsers
 * always do on WebSocket upgrades and cross-site fetches. Without this, any web
 * page the user visits could drive the server (cross-site WebSocket hijacking /
 * DNS rebinding). Trusted browser clients can be listed in D2_MCP_ALLOWED_ORIGINS.
 */
function originAllowed(req: IncomingMessage, allowed: Set<string>): boolean {
  const origin = req.headers['origin'];
  return origin === undefined || allowed.has(origin);
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

/** 404 for an unknown/expired session tells spec-compliant clients to re-initialize. */
function sessionNotFound(res: ServerResponse, sessionId: string | string[] | undefined) {
  if (sessionId) return sendJsonError(res, 404, -32001, 'Session not found');
  return sendJsonError(res, 400, -32000, 'Missing session ID');
}

function sendJsonError(res: ServerResponse, status: number, code: number, message: string) {
  if (res.headersSent) return;
  res
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
