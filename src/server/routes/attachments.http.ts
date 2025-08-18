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
    // Use original content type; ensure UTF-8 for human-readable types
    // In our test platform, some producers mislabel plaintext/markdown as PDF or omit charset.
    // Treat the following as textual and force charset=utf-8 when missing:
    //   - text/*
    //   - application/json, application/ld+json, application/x-ndjson
    //   - application/markdown, text/markdown
    //   - application/pdf (some producers actually send markdown/plaintext)
    let contentType = attachment.contentType || 'text/plain; charset=utf-8';
    const needsCharset = /^(text\/)$/i.test('text/') || /^(text\/)/i.test(contentType) || /^(application\/(json|ld\+json|x-ndjson|markdown|pdf))$/i.test('application/json') || /(application\/(json|ld\+json|x-ndjson|markdown|pdf))/i.test(contentType) || /^(text\/markdown)$/i.test('text/markdown');
    if ((/^text\//i.test(contentType) || /(application\/(json|ld\+json|x-ndjson|markdown|pdf))/i.test(contentType) || /^text\/markdown$/i.test(contentType)) && !/charset=/i.test(contentType)) {
      contentType = contentType + '; charset=utf-8';
    }
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
