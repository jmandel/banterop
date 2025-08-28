
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
  app.get('/scenarios/:id', (c) => { const id = c.req.param('id'); const s = store.get(id); return s ? c.json(s) : c.json({ error: `Scenario '${id}' not found` }, 404) });

  app.post('/scenarios', async (c) => {
    const body = await c.req.json().catch(()=>({}));
    const cfg = body?.config; const id = cfg?.metadata?.id;
    if (!cfg || !id) return c.json({ error: 'config.metadata.id is required' }, 400);
    if (store.get(id)) return c.json({ error: `Scenario with id '${id}' already exists` }, 409);
    store.insert(cfg); return c.json(store.get(id), 201);
  });

  app.put('/scenarios/:id', async (c) => {
    const id = c.req.param('id'); const existing = store.get(id);
    if (!existing) return c.json({ error: `Scenario '${id}' not found` }, 404);
    const g = guard(c, existing); if (!g.ok) return c.json({ error: g.msg }, g.code);
    const body = await c.req.json().catch(()=>({}));
    const cfg = body?.config; if (!cfg) return c.json({ error: 'config is required' }, 400);
    const incomingId = cfg?.metadata?.id; if (incomingId && incomingId !== id) return c.json({ error: 'config.metadata.id must match URL id' }, 400);
    store.update(id, cfg); return c.json(store.get(id));
  });

  app.delete('/scenarios/:id', (c) => {
    const id = c.req.param('id'); const existing = store.get(id);
    if (!existing) return c.json({ error: `Scenario '${id}' not found` }, 404);
    const g = guard(c, existing); if (!g.ok) return c.json({ error: g.msg }, g.code);
    store.delete(id); return c.json({ success:true, deleted:id });
  });

  return app;
}
