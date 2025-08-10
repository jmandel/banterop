import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { App } from '$src/server/app';
import { createConversationRoutes } from '$src/server/routes/conversations.http';

describe('Conversations HTTP routes', () => {
  let app: App;
  let server: any;
  let base: string;

  beforeEach(() => {
    app = new App({ dbPath: ':memory:' });
    const hono = new Hono().route('/api/conversations', createConversationRoutes(app.orchestrator));
    server = Bun.serve({ port: 0, fetch: hono.fetch });
    base = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
    server.stop();
    await app.shutdown();
  });

  it('lists conversations with default limit', async () => {
    const id = app.orchestrator.createConversation({ meta: { title: 'Test A', agents: [] } });
    expect(id).toBeGreaterThan(0);
    const res = await fetch(`${base}/api/conversations`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.conversations)).toBe(true);
    expect(data.conversations.length).toBeGreaterThan(0);
  });

  it('applies limit and hours filters', async () => {
    // Create two conversations
    const id1 = app.orchestrator.createConversation({ meta: { title: 'Now', agents: [] } });
    expect(id1).toBeGreaterThan(0);
    // Simulate older item by directly updating timestamp
    const id2 = app.orchestrator.createConversation({ meta: { title: 'Old', agents: [] } });
    expect(id2).toBeGreaterThan(0);
    // Manually set updated_at older than 24h for id2 (disable trigger first)
    app.orchestrator.storage.db.exec("DROP TRIGGER IF EXISTS trg_conversations_touch");
    const oldIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    app.orchestrator.storage.db.prepare(
      `UPDATE conversations SET updated_at = ? WHERE conversation = ?`
    ).run(oldIso, id2);

    // With hours=24, only the recent one should return
    const res = await fetch(`${base}/api/conversations?hours=24&limit=10`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    const titles = data.conversations.map((c: any) => c.metadata?.title);
    expect(titles).toContain('Now');
    expect(titles).not.toContain('Old');
  });
});
