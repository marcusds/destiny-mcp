import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';

/**
 * MCP `Transport` over an already-connected `ws` WebSocket.
 *
 * The MCP SDK communicates with a transport purely through the `onmessage`,
 * `onclose`, and `onerror` callback properties it assigns before calling
 * `start()` — it does not subscribe to EventEmitter events. Socket listeners
 * are therefore wired up in `start()`, after those callbacks exist, so inbound
 * frames are delivered to the SDK rather than dropped.
 */
export class WebSocketServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private closed = false;

  constructor(private readonly ws: WebSocket) {}

  async start(): Promise<void> {
    this.ws.on('message', (data) => this.handleMessage(data));
    this.ws.on('close', () => {
      this.closed = true;
      this.onclose?.();
    });
    this.ws.on('error', (error) => this.onerror?.(error));
  }

  private handleMessage(data: WebSocket.RawData): void {
    let message: JSONRPCMessage;
    try {
      message = JSONRPCMessageSchema.parse(JSON.parse(data.toString()));
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.onmessage?.(message);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket connection is closed');
    }
    await new Promise<void>((resolve, reject) => {
      this.ws.send(JSON.stringify(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.ws.close();
    }
  }
}
