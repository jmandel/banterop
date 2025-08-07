import { Hono } from 'hono';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';

export function createConversationRoutes(orchestrator: OrchestratorService) {
  const app = new Hono();

  app.get('/api/conversations', (c) => {
    const status = c.req.query('status') as 'active' | 'completed' | undefined;
    const scenarioId = c.req.query('scenarioId');
    const limit = Number(c.req.query('limit')) || 50;
    const offset = Number(c.req.query('offset')) || 0;
    
    const params: Parameters<typeof orchestrator.listConversations>[0] = { limit, offset };
    if (status !== undefined) params.status = status;
    if (scenarioId !== undefined) params.scenarioId = scenarioId;
    
    const conversations = orchestrator.listConversations(params);
    return c.json(conversations);
  });

  app.post('/api/conversations', async (c) => {
    const body = await c.req.json();
    const id = orchestrator.createConversation(body);
    const conversation = orchestrator.getConversation(id);
    return c.json(conversation, 201);
  });

  app.get('/api/conversations/:id', (c) => {
    const id = Number(c.req.param('id'));
    const includeEvents = c.req.query('includeEvents') === 'true';
    const includeMeta = c.req.query('includeMeta') === 'true';
    
    if (includeEvents) {
      const snap = orchestrator.getConversationSnapshot(id);
      return c.json(snap);
    } else if (includeMeta) {
      const conversation = orchestrator.getConversationWithMetadata(id);
      if (!conversation) {
        return c.json({ error: 'Conversation not found' }, 404);
      }
      return c.json(conversation);
    } else {
      const conversation = orchestrator.getConversation(id);
      if (!conversation) {
        return c.json({ error: 'Conversation not found' }, 404);
      }
      return c.json(conversation);
    }
  });

  app.get('/api/conversations/:id/events', (c) => {
    const id = Number(c.req.param('id'));
    const snap = orchestrator.getConversationSnapshot(id);
    return c.json(snap.events);
  });

  app.get('/api/conversations/:id/attachments', (c) => {
    const id = Number(c.req.param('id'));
    const attachments = orchestrator.listAttachmentsByConversation(id);
    return c.json(attachments);
  });

  app.get('/api/attachments/:id', (c) => {
    const id = c.req.param('id');
    const attachment = orchestrator.getAttachment(id);
    if (!attachment) {
      return c.json({ error: 'Attachment not found' }, 404);
    }
    return c.json(attachment);
  });

  app.get('/api/attachments/:id/content', (c) => {
    const id = c.req.param('id');
    const attachment = orchestrator.getAttachment(id);
    if (!attachment) {
      return c.json({ error: 'Attachment not found' }, 404);
    }
    
    c.header('Content-Type', attachment.contentType);
    c.header('Content-Disposition', `inline; filename="${attachment.name}"`);
    return c.body(attachment.content);
  });

  return app;
}