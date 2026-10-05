import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'events';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { runHttpServer } from '../src/server.js';
import { sleep } from './helpers.js';

process.env.D2_MCP_AUTH_TOKEN = 'secret';
const ctx: any = { auth: { isAuthenticated: () => false, getMembershipId: () => null } };
const { httpServer, sessions } = await runHttpServer(0, { ctx, sessionIdleMs: 150, sweepMs: 25 });
if (!httpServer.listening) await once(httpServer, 'listening');
const port = (httpServer.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
after(() => httpServer.close());

const AUTH = { authorization: 'Bearer secret' };
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  },
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
  });
}

/** Extract the JSON-RPC payload from an SSE or JSON response body. */
async function rpcResult(res: Response): Promise<any> {
  const body = await res.text();
  const data = body.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(data ? data.slice(5) : body);
}

test('requires the bearer token', async () => {
  assert.equal((await post(initialize)).status, 401);
  assert.equal((await post(initialize, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post(initialize, AUTH)).status, 200);
});

test('rejects browser origins on /mcp and WebSocket', async () => {
  assert.equal((await post(initialize, { ...AUTH, origin: 'https://evil.example' })).status, 403);
  const status = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { ...AUTH, origin: 'https://evil.example' },
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('open', () => (ws.close(), resolve('open')));
  });
  assert.equal(status, 403);
});

test('returns compact JSON from tool calls', async () => {
  const init = await post(initialize, AUTH);
  const sid = init.headers.get('mcp-session-id')!;
  const res = await post(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'auth_status', arguments: {} } },
    { ...AUTH, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26' }
  );
  const text = (await rpcResult(res)).result.content[0].text;
  assert.ok(!text.includes('\n'), text);
  assert.equal(JSON.parse(text).authenticated, false);
});

test('expires idle sessions and answers 404 so clients re-initialize', async () => {
  const sid = (await post(initialize, AUTH)).headers.get('mcp-session-id')!;
  assert.ok(sessions.has(sid));
  await sleep(300);
  assert.equal(sessions.has(sid), false);
  const res = await post(
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { ...AUTH, 'mcp-session-id': sid }
  );
  assert.equal(res.status, 404);
});
