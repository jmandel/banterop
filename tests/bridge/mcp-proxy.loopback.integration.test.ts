import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { App } from '$src/server/app';
import { createBridgeRoutes } from '$src/server/routes/bridge.mcp';
import { websocket } from '$src/server/ws/jsonrpc.server';

function toBase64Url(obj: any): string {
  const str = JSON.stringify(obj);
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

describe('MCP Proxy loopback (both sides our stack)', () => {
  let app: App;
  let server: any;
  let baseUrl: string;

  beforeAll(() => {
    app = new App({ dbPath: ':memory:' });
    const hono = new Hono();
    // Mount MCP bridge with lifecycle manager persistence
    hono.route('/api/bridge', createBridgeRoutes(app.orchestrator, app.llmProviderManager, app.lifecycleManager, 200));
    server = Bun.serve({ port: 0, fetch: hono.fetch, websocket });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop();
    await app.shutdown();
  });

  it('creates local+remote conversations and proxies turns end-to-end', async () => {
    // Remote template (insurer side): external patient + internal insurer (assistant), patient starts
    const remoteTemplate = {
      title: 'Knee MRI Prior Auth — Insurer',
      agents: [
        { id: 'patient' },
        { id: 'insurer', agentClass: 'AssistantAgent' }
      ],
      startingAgentId: 'patient'
    };
    const remoteConfig64 = toBase64Url(remoteTemplate);

    // Local conversation (A): scenario patient replaced with Assistant for deterministic test; proxy bridges to our own bridge
    const localMeta = {
      title: 'Knee MRI Prior Auth — Local',
      agents: [
        { id: 'patient', agentClass: 'AssistantAgent' },
        {
          id: 'insurer-proxy',
          agentClass: 'mcp-proxy',
          config: {
            remoteBaseUrl: `${baseUrl}/api/bridge/${remoteConfig64}/mcp`,
            bridgedAgentId: 'insurer',
            counterpartyAgentId: 'patient',
            waitMs: 1000
          }
        }
      ],
      startingAgentId: 'patient'
    };

    // Create local conversation directly via orchestrator
    const conversationA = app.orchestrator.createConversation({ meta: localMeta as any });

    // Ensure local agents running (patient + proxy)
    await app.lifecycleManager.ensure(conversationA, ['patient', 'insurer-proxy']);

    // Post an initial message from the local patient to kick things off
    app.orchestrator.sendMessage(conversationA, 1, 'patient', { text: 'Hello, requesting MRI authorization.' }, 'turn');

    // Wait for proxy to forward and mirror a reply locally as 'insurer'
    let seenInsurer = false;
    for (let i = 0; i < 50; i++) {
      const snap = app.orchestrator.getConversationSnapshot(conversationA, { includeScenario: false });
      if ((snap.events || []).some((e) => e.type === 'message' && e.agentId === 'insurer')) {
        seenInsurer = true;
        break;
      }
      await sleep(100);
    }
    expect(seenInsurer).toBe(true);

    // Confirm that a second (remote) conversation exists on our server
    const allConvos = app.orchestrator.storage.conversations.list({});
    expect(allConvos.length).toBeGreaterThanOrEqual(2);
    expect(allConvos.some((c) => c.conversation !== conversationA)).toBe(true);
  });
});
