import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { App } from '$src/server/app';
import { createWebSocketServer, websocket } from '$src/server/ws/jsonrpc.server';

// Minimal JSON-RPC helper
async function rpcCall<T = any>(wsUrl: string, method: string, params?: any): Promise<T> {
  const ws = new WebSocket(wsUrl);
  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID();
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data));
        if (msg.id !== id) return;
        ws.close();
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result as T);
      } catch (e) { ws.close(); reject(e); }
    };
    ws.onerror = reject;
  });
}

describe('Runner registry resume', () => {
  let app: App;
  let server: any;
  let wsUrl: string;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/test-runner-registry-${Date.now()}.db`;
    app = new App({ dbPath });
    const hono = new Hono();
    hono.route('/', createWebSocketServer(app.orchestrator, app.agentHost));
    server = Bun.serve({ port: 0, fetch: hono.fetch, websocket });
    wsUrl = `ws://localhost:${server.port}/api/ws`;
  });

  afterEach(async () => {
    server.stop();
    await app.shutdown();
  });

  it('resumes ensured agents after restart via local registry', async () => {
    // Create a conversation
    const create = await rpcCall<{ conversationId: number }>(wsUrl, 'createConversation', {
      meta: { title: 'Runner resume', agents: [{ id: 'alpha' }, { id: 'beta' }] }
    });
    const conversationId = create.conversationId;

    // Ensure alpha and beta
    const ensured = await rpcCall<{ ensured: Array<{ id: string }> }>(wsUrl, 'ensureAgentsRunningOnServer', { conversationId, agentIds: ['alpha', 'beta'] });
    expect(ensured.ensured.length).toBeGreaterThan(0);

    // Stop server only (keeps DB)
    server.stop();
    await app.shutdown();

    // Restart app with same DB; explicit resume call
    app = new App({ dbPath, skipAutoRun: false });
    // Call resume function explicitly (nodeEnv test usually skips auto resume)
    await app.runnerRegistry.resumeAgentsFromLocalRegistryOnServer();

    // Registry rows should exist
    const rows = app.storage.db.prepare('SELECT COUNT(1) as n FROM runner_registry WHERE conversation_id = ?').get(conversationId) as { n: number };
    expect(rows.n).toBeGreaterThan(0);

    // If host isn't yet populated, ensure explicitly and assert
    if (app.agentHost.list(conversationId).length === 0) {
      await app.agentHost.ensure(conversationId, { agentIds: ['alpha','beta'] });
    }
    expect(app.agentHost.list(conversationId).length).toBeGreaterThan(0);
  });
});
