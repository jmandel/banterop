// src/server/routes/debug/sql.readonly.ts
import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';

export function mountSqlReadOnly(api: Hono, db: Database) {
  const ALLOW = new Set([
    'conversations',
    'conversation_events',
    'attachments',
    'scenarios',
    'idempotency_keys',
    'runner_registry',
  ]);

  api.post('/sql/read', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { sql?: string; params?: Record<string, unknown> };
      const sql = typeof body.sql === 'string' ? body.sql : '';
      if (!/^\s*select\b/i.test(sql)) return c.json({ error: 'Only SELECT allowed' }, 400);

      const tables = [...sql.toLowerCase().matchAll(/\b(from|join)\s+([a-z_][\w]*)/g)].map((m) => m[2] as string);
      if (tables.some((t) => !ALLOW.has(t))) return c.json({ error: 'Unknown table' }, 400);

      const LIMIT_DEFAULT = 200;
      const safeSql = /\blimit\b/i.test(sql) ? sql : `${sql.trim()} LIMIT ${LIMIT_DEFAULT}`;

      const start = Date.now();
      const rows = await Promise.race<unknown[]>([
        Promise.resolve(db.prepare(safeSql).all(
          body && body.params && typeof body.params === 'object' ? (body.params as any) : undefined
        ) as unknown[]),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000)),
      ]);
      return c.json({ rows, ms: Date.now() - start, appliedLimit: /\blimit\b/i.test(sql) ? undefined : LIMIT_DEFAULT });
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'query_failed' }, 400);
    }
  });
}
