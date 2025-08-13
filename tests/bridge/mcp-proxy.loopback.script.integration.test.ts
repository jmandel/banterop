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

describe('MCP Proxy loopback with ScriptAgents (6 turns, auto-close)', () => {
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

  it('runs 6 alternating turns and reaches conversation finality', async () => {
    // Remote template: external patient + internal insurer (scripted)
    const remoteTemplate = {
      title: 'Scripted Prior Auth — Insurer',
      agents: [
        { id: 'patient' },
        {
          id: 'insurer',
          agentClass: 'script',
          config: {
            script: {
              name: 'insurer-script',
              turns: [
                [{ kind: 'post', text: 'I1', finality: 'turn' }],
                [{ kind: 'post', text: 'I2', finality: 'turn' }],
                // Final reply ends the conversation remotely; proxy will mirror as conversation finality
                [{ kind: 'post', text: 'I3', finality: 'conversation' }]
              ]
            }
          }
        }
      ],
      startingAgentId: 'patient'
    };
    const remoteConfig64 = toBase64Url(remoteTemplate);

    // Local conversation (A): patient scripted; proxy bridges to our own bridge
    const localMeta = {
    title: 'Scripted Prior Auth — Local',
      // No maxTurns reliance; finality propagated from remote on turn 6
      agents: [
        {
          id: 'patient',
          agentClass: 'script',
          config: {
            script: {
              name: 'patient-script',
              turns: [
                [{ kind: 'post', text: 'P1', finality: 'turn' }],
                [{ kind: 'post', text: 'P2', finality: 'turn' }],
                [{ kind: 'post', text: 'P3', finality: 'turn' }]
              ]
            }
          }
        },
        {
          id: 'insurer-proxy',
          agentClass: 'mcp-proxy',
          config: {
            remoteBaseUrl: `${baseUrl}/api/bridge/${remoteConfig64}/mcp`,
            bridgedAgentId: 'insurer-proxy',
            counterpartyAgentId: 'patient',
            waitMs: 1000
          }
        }
      ],
      startingAgentId: 'patient'
    } as const;

    // Create local conversation directly via orchestrator
    const conversationA = app.orchestrator.createConversation({ meta: localMeta as any });

    // Ensure local agents running (patient + proxy); AgentHost pokes guidance post-ensure
    await app.lifecycleManager.ensure(conversationA, ['patient', 'insurer-proxy']);

    // Poll until conversation is completed or timeout
    let completed = false;
    for (let i = 0; i < 40; i++) {
      const snap = app.orchestrator.getConversationSnapshot(conversationA, { includeScenario: false });
      const count = (snap.events || []).filter((e) => e.type === 'message').length;
      if (i % 10 === 0) { /* progress log */ }
      if (snap.status === 'completed') {
        completed = true;
        break;
      }
      await sleep(100);
    }
    if (!completed) {
      const finalSnap = app.orchestrator.getConversationSnapshot(conversationA, { includeScenario: false });
      const finalMsgs = (finalSnap.events || []).filter((e) => e.type === 'message');
      throw new Error(
        'Did not complete. Final: ' +
        JSON.stringify({
          status: finalSnap.status,
          messages: finalMsgs.map(m => ({ seq: m.seq, agentId: m.agentId, finality: m.finality, text: (m.payload as any)?.text }))
        })
      );
    }
    expect(completed).toBe(true);

    // Validate turns and finality sequence
    const snap = app.orchestrator.getConversationSnapshot(conversationA, { includeScenario: false });
    const msgs = (snap.events || []).filter((e) => e.type === 'message');
    console.log('msgs:', msgs.map(m => ({ seq: m.seq, agentId: m.agentId, finality: m.finality, text: (m.payload as any)?.text })));
    // Expect exactly 6 agent messages; the 6th should have finality=conversation and from 'insurer'
    expect(msgs.length).toBe(6);

    // Check alternation of agentIds for the 6 agent messages
    const agentsSequence = msgs.map((m) => m.agentId);
    expect(agentsSequence).toEqual([
      'patient',
      'insurer-proxy',
      'patient',
      'insurer-proxy',
      'patient',
      'insurer-proxy',
    ]);

    // First five close turns; last closes conversation
    for (let i = 0; i < msgs.length; i++) {
      if (i < msgs.length - 1) expect(msgs[i]!.finality).toBe('turn');
      else expect(msgs[i]!.finality).toBe('conversation');
    }

    // Confirm that a second (remote) conversation exists on our server
    const allConvos = app.orchestrator.storage.conversations.list({});
    expect(allConvos.length).toBeGreaterThanOrEqual(2);
    expect(allConvos.some((c) => c.conversation !== conversationA)).toBe(true);
  });
});
