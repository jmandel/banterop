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

describe('ensureAgentsRunning is idempotent per conversation', () => {
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

  it('two concurrent ensure calls should not start duplicate agents', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e as any);
    });

    // Subscribe to conversations to learn ID
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

    // Capture conversationId and subscribe to its events
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

    // Create conversation with an Assistant agent that speaks on ensure
    await wsCall<{ conversationId: number }>(ws, 'createConversation', {
      meta: {
        title: 'Dedup ensure test',
        startingAgentId: 'alpha',
        agents: [
          { id: 'alpha', agentClass: 'AssistantAgent', displayName: 'Alpha' },
        ],
      },
    });
    await subscribedToConversation;
    expect(conversationId).toBeGreaterThan(0);

    // Count message events from alpha over a small window
    let alphaMessages = 0;
    const onMsg = (evt: MessageEvent) => {
      try {
        const msg = JSON.parse(String(evt.data));
        if (msg.method === 'event' && msg.params?.type === 'message' && msg.params?.agentId === 'alpha') {
          alphaMessages += 1;
        }
      } catch {}
    };
    ws.addEventListener('message', onMsg);

    // Fire two ensures concurrently
    const control = new WsControl(wsUrl);
    await Promise.all([
      control.lifecycleEnsure(conversationId, ['alpha']),
      control.lifecycleEnsure(conversationId, ['alpha']),
    ]);

    // Wait briefly for any events to arrive
    await new Promise((r) => setTimeout(r, 1500));
    ws.removeEventListener('message', onMsg);

    // Only one assistant instance should have spoken
    expect(alphaMessages).toBe(1);
    ws.close();
  });
});
