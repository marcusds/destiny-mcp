import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

import { DestinyAPI } from './destiny-api.js';
import { BungieAuth } from './auth.js';
import { ManifestManager } from './manifest.js';
import { WebSocketServerTransport } from './websocket-transport.js';
import { loadConfig } from './config.js';
import { allTools, toolMap, ToolContext } from './tools/index.js';

export function buildContext(): ToolContext {
  const config = loadConfig();
  const auth = new BungieAuth(config);
  const api = new DestinyAPI(config, auth);
  const manifest = new ManifestManager(api, config);
  return { api, auth, manifest };
}

export function createMCPServer(ctx: ToolContext = buildContext()) {
  const server = new Server({ name: 'd2-mcp', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = toolMap.get(name);
    if (!entry) {
      return errorResult(`Unknown tool: ${name}`);
    }
    try {
      const result = await entry.handler(ctx, args ?? {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
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
  const server = createMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`d2-mcp running on stdio (${allTools.length} tools)`);
}

export async function runWebSocketServer(port = 3000) {
  const ctx = buildContext();
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    console.error('New WebSocket connection established');
    const server = createMCPServer(ctx);
    const transport = new WebSocketServerTransport(ws);
    server.connect(transport).catch((error) => {
      console.error('Server connection error:', error);
    });
    ws.on('close', () => console.error('WebSocket connection closed'));
    ws.on('error', (error) => console.error('WebSocket error:', error));
  });

  httpServer.listen(port, () => {
    console.error(`d2-mcp running on WebSocket port ${port} (ws://localhost:${port})`);
  });

  return { httpServer, wss };
}
