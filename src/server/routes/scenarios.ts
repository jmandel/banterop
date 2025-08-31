
import { Hono } from 'hono';

function isPublished(sc: any) { const t = sc?.metadata?.tags; return Array.isArray(t) && t.includes('published') }

export function createScenariosRoutes(store: any) {
  const app = new Hono();

  const guard = (c: any, sc: any) => {
    if (!isPublished(sc)) return { ok: true };
    const tok = (process.env.PUBLISHED_EDIT_TOKEN || '').toString();
    if (!tok) return { ok: true };
    const hdr = c.req.header('X-Edit-Token') || '';
    return hdr === tok ? { ok: true } : { ok: false, code: 423, msg: 'Locked published scenario. Invalid or missing token.' };
  };

  app.get('/scenarios', (c) => c.json(store.list()));
  app.get('/scenarios/:id', (c) => {
    const id = c.req.param('id'); const s = store.get(id);
    if (!s) { c.status(404); return c.json({ error: `Scenario '${id}' not found` }); }
    return c.json(s);
  });

  app.post('/scenarios', async (c) => {
    const body = await c.req.json().catch(()=>({}));
    const cfg = body?.config; const id = cfg?.metadata?.id;
    if (!cfg || !id) { c.status(400); return c.json({ error: 'config.metadata.id is required' }); }
    if (store.get(id)) { c.status(409); return c.json({ error: `Scenario with id '${id}' already exists` }); }
    store.insert(cfg); c.status(201); return c.json(store.get(id));
  });

  app.put('/scenarios/:id', async (c) => {
    const id = c.req.param('id'); const existing = store.get(id);
    if (!existing) { c.status(404); return c.json({ error: `Scenario '${id}' not found` }); }
    const g = guard(c, existing); if (!g.ok) { c.status((g.code ?? 423) as any); return c.json({ error: g.msg }); }
    const body = await c.req.json().catch(()=>({}));
    const cfg = body?.config; if (!cfg) { c.status(400); return c.json({ error: 'config is required' }); }
    const incomingId = cfg?.metadata?.id; if (incomingId && incomingId !== id) { c.status(400); return c.json({ error: 'config.metadata.id must match URL id' }); }
    store.update(id, cfg); return c.json(store.get(id));
  });

  app.delete('/scenarios/:id', (c) => {
    const id = c.req.param('id'); const existing = store.get(id);
    if (!existing) { c.status(404); return c.json({ error: `Scenario '${id}' not found` }); }
    const g = guard(c, existing); if (!g.ok) { c.status((g.code ?? 423) as any); return c.json({ error: g.msg }); }
    store.delete(id); return c.json({ success:true, deleted:id });
  });

  return app;
}
