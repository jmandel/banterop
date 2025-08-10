import { Hono } from 'hono';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';

export function createConversationRoutes(orchestrator: OrchestratorService) {
  const app = new Hono();

  // GET /api/conversations?status=active|completed&scenarioId=...&limit=&offset=
  app.get('/', (c) => {
    const url = new URL(c.req.url);
    const status = url.searchParams.get('status') as 'active' | 'completed' | null;
    const scenarioId = url.searchParams.get('scenarioId') || undefined;
    const limit = url.searchParams.get('limit');
    const offset = url.searchParams.get('offset');
    const hours = url.searchParams.get('hours');
    const updatedAfter = url.searchParams.get('updatedAfter') || undefined;

    let updatedAfterIso = updatedAfter;
    if (!updatedAfterIso && hours) {
      const h = Number(hours);
      if (Number.isFinite(h) && h > 0) {
        updatedAfterIso = new Date(Date.now() - h * 3600 * 1000).toISOString();
      }
    }

    const conversations = orchestrator.listConversations({
      ...(status ? { status } : {}),
      ...(scenarioId ? { scenarioId } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
      ...(offset ? { offset: Number(offset) } : {}),
      ...(updatedAfterIso ? { updatedAfter: updatedAfterIso } : {}),
    } as any);

    return c.json({ conversations });
  });

  return app;
}
