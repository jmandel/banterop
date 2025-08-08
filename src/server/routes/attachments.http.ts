import { Hono } from 'hono';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';

export function createAttachmentRoutes(orchestrator: OrchestratorService) {
  const app = new Hono();

  app.get('/attachments/:id', (c) => {
    const id = c.req.param('id');
    const attachment = orchestrator.getAttachment(id);
    if (!attachment) return c.json({ error: 'Attachment not found' }, 404);
    return c.json(attachment);
  });

  app.get('/attachments/:id/content', (c) => {
    const id = c.req.param('id');
    const attachment = orchestrator.getAttachment(id);
    if (!attachment) return c.json({ error: 'Attachment not found' }, 404);
    c.header('Content-Type', attachment.contentType);
    c.header('Content-Disposition', `inline; filename="${attachment.name}"`);
    return c.body(attachment.content);
  });

  return app;
}