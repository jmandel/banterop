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
    // Use original content type; default to text/plain when absent
    const contentType = attachment.contentType || 'text/plain; charset=utf-8';
    c.header('Content-Type', contentType);

    // Build a safe Content-Disposition value:
    // - ASCII-only fallback filename (replace non-ASCII/quotes with underscore)
    // - RFC 5987 filename* with UTF-8 percent-encoding for full fidelity
    const rawName = attachment.name || 'attachment';
    const asciiFallback = rawName
      .replace(/[\r\n]/g, ' ')
      .replace(/"/g, "'")
      .replace(/[^\x20-\x7E]/g, '_');
    const encodedExt = encodeURIComponent(rawName)
      .replace(/\*/g, '%2A')
      .replace(/%20/g, '%20');
    const cd = `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodedExt}`;
    c.header('Content-Disposition', cd);
    return c.body(attachment.content);
  });

  return app;
}
