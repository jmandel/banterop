// src/server/routes/debug/index.ts
import { Hono } from 'hono';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import { mountSqlReadOnly } from './sql.readonly';

export function createDebugRoutes(orchestrator: OrchestratorService) {
  const api = new Hono();
  const db = orchestrator.storage.db;
  const conversations = orchestrator.storage.conversations;
  const events = orchestrator.storage.events;
  const scenarios = orchestrator.storage.scenarios;
  const attachments = orchestrator.storage.attachments;

  api.get('/overview', (c) => {
    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
         FROM conversations`
      )
      .get() as { active?: number; completed?: number };

    const open = db
      .prepare(
        `SELECT COUNT(1) AS c FROM (
           SELECT conversation,
                  (SELECT finality FROM conversation_events e
                    WHERE e.conversation = c.conversation AND e.type='message'
                    ORDER BY seq DESC LIMIT 1) AS last_finality
           FROM conversations c
           WHERE status='active') WHERE last_finality = 'none'`
      )
      .get() as { c?: number };

    const recent = db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversation_events
         WHERE ts >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')`
      )
      .get() as { n?: number };

    return c.json({
      activeConversations: counts.active ?? 0,
      completedConversations: counts.completed ?? 0,
      eventsPerMinute: recent.n ?? 0,
      openTurnConversations: open.c ?? 0,
      ts: new Date().toISOString(),
    });
  });

  api.get('/conversations', (c) => {
    const status = c.req.query('status') as 'active' | 'completed' | undefined;
    const list = conversations.list({ status, limit: 200 });
    return c.json(list);
  });

  api.get('/conversations/:id/snapshot', (c) => {
    const id = Number(c.req.param('id'));
    const convo = conversations.getWithMetadata(id);
    if (!convo) return c.json({ error: 'not_found' }, 404);
    const head = events.getHead(id);
    const scenarioId = (convo as any).metadata?.scenarioId as string | undefined;
    const scenario = scenarioId ? scenarios.findScenarioById(scenarioId) : null;
    return c.json({ conversation: id, head, snapshot: convo, scenario });
  });

  api.get('/conversations/:id/events', (c) => {
    const id = Number(c.req.param('id'));
    const afterSeq = c.req.query('afterSeq') ? Number(c.req.query('afterSeq')) : undefined;
    const limit = c.req.query('limit') ? Math.min(1000, Number(c.req.query('limit'))) : 200;
    const page = events.getEventsPage(id, afterSeq, limit);
    return c.json({ events: page });
  });

  api.get('/attachments/:id', (c) => {
    const id = c.req.param('id');
    const meta = attachments.getById(id);
    if (!meta) return c.json({ error: 'not_found' }, 404);
    return c.json(meta);
  });

  api.get('/attachments/:id/content', (c) => {
    const id = c.req.param('id');
    const meta = attachments.getById(id);
    if (!meta) return c.json({ error: 'not_found' }, 404);
    return new Response(meta.content, {
      headers: {
        'Content-Type': meta.contentType,
        'Content-Disposition': `inline; filename="${meta.name}"`,
      },
    });
  });

  api.get('/scenarios', (c) => c.json(scenarios.listScenarios()));

  api.get('/runners', (c) => {
    const registry = db
      .prepare(
        `SELECT conversation_id as conversationId, agent_id as agentId, created_at as createdAt
         FROM runner_registry ORDER BY created_at DESC`
      )
      .all() as Array<{ conversationId: number; agentId: string; createdAt: string }>;

    const seen = db
      .prepare(
        `SELECT agent_id AS agentId, MAX(ts) AS lastSeen, COUNT(*) AS countEvents
         FROM conversation_events
         WHERE ts >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')
         GROUP BY agent_id`
      )
      .all() as Array<{ agentId: string; lastSeen: string; countEvents: number }>;

    const seenMap = new Map(seen.map((s) => [s.agentId, s]));
    const managedAgents = new Set(registry.map((r) => r.agentId));
    const observed = db
      .prepare(
        `SELECT DISTINCT agent_id AS agentId FROM conversation_events
         WHERE ts >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')`
      )
      .all() as Array<{ agentId: string }>;

    const union = new Set<string>([...managedAgents, ...observed.map((o) => o.agentId)]);
    const runners = [...union].map((agentId) => {
      const s = seenMap.get(agentId);
      return { agentId, managed: managedAgents.has(agentId), lastSeen: s?.lastSeen ?? null, countEvents24h: s?.countEvents ?? 0 };
    });

    return c.json({ runners, registry });
  });

  api.get('/config', (c) => {
    const host = c.req.header('host');
    const proto = c.req.header('x-forwarded-proto') ?? 'http';
    const wsProto = proto === 'https' ? 'wss' : 'ws';
    return c.json({ apiBase: '/api/debug', wsUrl: `${wsProto}://${host}/api/ws` });
  });

  mountSqlReadOnly(api, db);
  return api;
}

