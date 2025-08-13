import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { App } from '$src/server/app';
import { createWebSocketServer, websocket } from '$src/server/ws/jsonrpc.server';

describe('WS subscribeConversations', () => {
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

  it('pushes a conversation notification on creation', async () => {
    const ws = new WebSocket(wsUrl);

    const convoPushed = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout waiting for conversation push')), 2000);
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data));
          // First response: subId; Second: conversation push
          if (msg.method === 'conversation' && msg.params?.conversationId) {
            clearTimeout(timeout);
            resolve(msg.params.conversationId as number);
          }
        } catch (e) {
          // ignore parse errors
        }
      };
      ws.onerror = (e) => reject(e as any);
    });

    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        // 1) subscribe
        const subId = crypto.randomUUID();
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: subId, method: 'subscribeConversations' }));
        resolve();
      };
    });

    // 2) create conversation via WS to trigger meta_created
    const createId = crypto.randomUUID();
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: createId,
      method: 'createConversation',
      params: { meta: { title: 'WS Push Test', agents: [] } },
    }));

    const conversationId = await convoPushed;
    expect(typeof conversationId).toBe('number');
    expect(conversationId).toBeGreaterThan(0);

    ws.close();
  });
});
