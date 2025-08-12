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

async function main() {
  const app = new App({ dbPath: ':memory:' });
  const hono = new Hono();
  hono.route('/api/bridge', createBridgeRoutes(app.orchestrator, app.llmProviderManager, app.runnerRegistry, 150));
  const server = Bun.serve({ port: 0, fetch: hono.fetch, websocket });
  const baseUrl = `http://localhost:${server.port}`;

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
              [{ kind: 'post', text: 'I3', finality: 'conversation' }]
            ]
          }
        }
      }
    ],
    startingAgentId: 'patient'
  };
  const remoteConfig64 = toBase64Url(remoteTemplate);

  const localMeta = {
    title: 'Scripted Prior Auth — Local',
    agents: [
      {
        id: 'patient',
        agentClass: 'script',
        config: {
          script: {
            name: 'patient-script',
            maxTurns: 10,
            turns: [
              [{ kind: 'post', text: 'P1', finality: 'turn' }],
              [
                { kind: 'sleep', ms: 120 },
                { kind: 'post', text: 'P2', finality: 'turn' }
              ],
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
          waitMs: 50
        }
      }
    ],
    startingAgentId: 'patient'
  } as const;

  const conversationA = app.orchestrator.createConversation({ meta: localMeta as any });
  await app.runnerRegistry.ensureAgentsRunningOnServer(conversationA, ['patient', 'insurer-proxy']);
  // No manual kickoff; rely on patient script P1

  // Poll up to 2s for completion
  for (let i = 0; i < 20; i++) {
    const snap = app.orchestrator.getConversationSnapshot(conversationA, { includeScenario: false });
    const msgs = (snap.events || []).filter((e) => e.type === 'message');
    console.log(`[poll ${i}] status=${snap.status} msgs=${msgs.length}`);
    if (snap.status === 'completed') break;
    await sleep(100);
  }

  const snap = app.orchestrator.getConversationSnapshot(conversationA, { includeScenario: false });
  const msgs = (snap.events || []).filter((e) => e.type === 'message');
  console.log('RESULT messages:');
  for (const m of msgs) {
    console.log({ seq: m.seq, turn: m.turn, agentId: m.agentId, finality: m.finality, text: (m.payload as any)?.text });
  }
  console.log('status:', snap.status);

  server.stop();
  await app.shutdown();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
