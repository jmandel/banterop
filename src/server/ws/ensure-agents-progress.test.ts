import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { App } from '$src/server/app';
import { createWebSocketServer, websocket } from '$src/server/ws/jsonrpc.server';

// Helper to call a WS JSON-RPC method and resolve with result
function wsCall<T = any>(ws: WebSocket, method: string, params?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const onMessage = (evt: MessageEvent) => {
      try {
        const msg = JSON.parse(String(evt.data));
        if (msg.id === id) {
          ws.removeEventListener('message', onMessage);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result as T);
        }
      } catch (e) {
        // ignore
      }
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

describe('ensureAgentsRunning leads to progress', () => {
  let app: App;
  let server: any;
  let wsUrl: string;

  beforeEach(async () => {
    app = new App({ dbPath: ':memory:' });
    const hono = new Hono();
    hono.route('/', createWebSocketServer(app.orchestrator, app.agentHost));
    server = Bun.serve({ port: 0, fetch: hono.fetch, websocket });
    wsUrl = `ws://localhost:${server.port}/api/ws`;
  });

  afterEach(async () => {
    server.stop();
    await app.shutdown();
  });

  it('server-managed assistant posts a message after ensure', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e as any);
    });

    // Create a conversation with startingAgentId so guidance immediately targets 'alpha'
    const createRes = await wsCall<{ conversationId: number }>(ws, 'createConversation', {
      meta: {
        title: 'Server-side run test',
        startingAgentId: 'alpha',
        agents: [
          { id: 'alpha', agentClass: 'AssistantAgent', displayName: 'Alpha' },
          { id: 'beta', agentClass: 'EchoAgent', displayName: 'Beta' },
        ],
      },
    });
    const conversationId = createRes.conversationId;
    expect(conversationId).toBeGreaterThan(0);

    // Subscribe to events and await confirmation
    const subId = crypto.randomUUID();
    const subscribed = new Promise<void>((resolve) => {
      const onMsg = (evt: MessageEvent) => {
        try {
          const msg = JSON.parse(String(evt.data));
          if (msg.id === subId && msg.result?.subId) {
            ws.removeEventListener('message', onMsg);
            resolve();
          }
        } catch {}
      };
      ws.addEventListener('message', onMsg);
    });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: subId, method: 'subscribe', params: { conversationId } }));
    await subscribed;

    // Ensure server agents (alpha) are running
    await wsCall(ws, 'ensureAgentsRunning', { conversationId, agentIds: ['alpha'] });

    // Wait for a message event from alpha within a short window
    const gotMessage = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      ws.addEventListener('message', (evt) => {
        try {
          const msg = JSON.parse(String(evt.data));
          if (msg.method === 'event' && msg.params?.type === 'message' && msg.params?.agentId === 'alpha') {
            clearTimeout(timer);
            resolve(true);
          }
        } catch {}
      });
    });

    expect(gotMessage).toBe(true);
    ws.close();
  });
});
