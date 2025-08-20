// src/server/routes/bridge.a2a.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { ServerAgentLifecycleManager } from '$src/server/control/server-agent-lifecycle';
import { parseConversationMetaFromConfig64 } from '$src/server/bridge/conv-config.types';
import { A2ABridgeServer } from '$src/server/bridge/a2a-server';
import { buildScenarioAgentCard } from '$src/server/bridge/a2a-wellknown';

export function createA2ARoutes(
  orchestrator: OrchestratorService,
  lifecycle: ServerAgentLifecycleManager
) {
  const app = new Hono();
  // Enable CORS for standalone mounts (tests or embedded usage)
  app.use('*', cors({ origin: (origin) => origin ?? '*', credentials: true }));

  // JSON-RPC multiplexer (message/send, message/stream, tasks/*)
  app.post('/:config64/a2a', async (c) => {
    const config64 = c.req.param('config64');
    let body: any = undefined;
    if (c.req.method === 'POST') {
      try { body = await c.req.json(); } catch { body = undefined; }
    }

    const bridge = new A2ABridgeServer({ orchestrator, lifecycle }, config64);
    try {
      return await bridge.handleJsonRpc(c, body);
    } catch (err: any) {
      const id = body?.id ?? null;
      console.error("[A2ARoutes] JSON-RPC error:", err);
      return c.json({ jsonrpc: '2.0', id, error: { code: -32603, message: err?.message ?? 'Internal error' } }, 500);
    }
  });

  // Diagnostics: decode config64 and echo meta
  app.get('/:config64/a2a/diag', (c) => {
    try {
      const meta = parseConversationMetaFromConfig64(c.req.param('config64'));
      return c.json({ ok: true, meta, notes: 'ConversationMeta for this A2A base.' });
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message ?? String(err) }, 400);
    }
  });

  // Scenario-specific Agent Card (well-known, per-config)
  app.get('/:config64/a2a/.well-known/agent-card.json', (c) => {
    const config64 = c.req.param('config64');
    const baseUrl = new URL(c.req.url);
    baseUrl.pathname = baseUrl.pathname.replace(/\/\.well-known\/agent-card\.json$/, '');
    const card = buildScenarioAgentCard(baseUrl, config64, orchestrator);
    return c.json(card);
  });

  return app;
}
