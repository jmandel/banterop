import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { App } from '$src/server/app';
import { createWebSocketServer, websocket } from '$src/server/ws/jsonrpc.server';
import { WsControl } from '$src/control/ws.control';

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
    hono.route('/', createWebSocketServer(app.orchestrator, app.agentHost, app.lifecycleManager));
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

    // 1) Subscribe to conversation creations first
    const convSubId = crypto.randomUUID();
    await new Promise<void>((resolve) => {
      const onMsg = (evt: MessageEvent) => {
        try {
          const msg = JSON.parse(String(evt.data));
          if (msg.id === convSubId && msg.result?.subId) {
            ws.removeEventListener('message', onMsg);
            resolve();
          }
        } catch {}
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: convSubId, method: 'subscribeConversations' }));
    });

    // Prepare to capture conversationId and subscribe to its events (includeGuidance)
    let conversationId = 0;
    const subscribedToConversation = new Promise<void>((resolve) => {
      const onConv = (evt: MessageEvent) => {
        try {
          const msg = JSON.parse(String(evt.data));
          if (msg.method === 'conversation' && msg.params?.conversationId) {
            conversationId = Number(msg.params.conversationId);
            ws.removeEventListener('message', onConv);

            const subId = crypto.randomUUID();
            const onSub = (evt2: MessageEvent) => {
              try {
                const m = JSON.parse(String(evt2.data));
                if (m.id === subId && m.result?.subId) {
                  ws.removeEventListener('message', onSub);
                  resolve();
                }
              } catch {}
            };
            ws.addEventListener('message', onSub);
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: subId, method: 'subscribe', params: { conversationId, includeGuidance: true } }));
          }
        } catch {}
      };
      ws.addEventListener('message', onConv);
    });

    // 2) Now create the conversation
    await wsCall<{ conversationId: number }>(ws, 'createConversation', {
      meta: {
        title: 'Server-side run test',
        startingAgentId: 'alpha',
        agents: [
          { id: 'alpha', agentClass: 'AssistantAgent', displayName: 'Alpha' },
          { id: 'beta', agentClass: 'EchoAgent', displayName: 'Beta' },
        ],
      },
    });
    await subscribedToConversation;
    expect(conversationId).toBeGreaterThan(0);

    // 3) Prepare message listener BEFORE ensure to avoid races
    const gotMessage = new Promise<boolean>((resolve) => {
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

    // 4) Ensure alpha runs on server
    const control = new WsControl(wsUrl);
    const ensured = await control.lifecycleEnsure(conversationId, ['alpha']);
    console.error('ensured from server:', ensured);
    expect(Array.isArray(ensured.ensured)).toBe(true);
    expect(ensured.ensured.some(e => e.id === 'alpha')).toBe(true);

    // 5) Await pushed message from alpha (event-driven)
    expect(await gotMessage).toBe(true);
    ws.close();
  });
});
