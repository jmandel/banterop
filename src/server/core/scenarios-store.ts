
import { Database } from 'bun:sqlite';

export type Scenario = any;

export function createScenariosStore(db: Database) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS scenarios (
      config TEXT NOT NULL CHECK (json_valid(config))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scenarios_id
      ON scenarios((json_extract(config, '$.metadata.id')));
    CREATE INDEX IF NOT EXISTS idx_scenarios_title
      ON scenarios((json_extract(config, '$.metadata.title')));
    CREATE INDEX IF NOT EXISTS idx_scenarios_tags
      ON scenarios((json_extract(config, '$.metadata.tags')));
  `);

  const insert = db.query('INSERT INTO scenarios (config) VALUES (json(?))') as any;
  const selectAll = db.query<{ config: string }, []>('SELECT config FROM scenarios');
  const selectOne = db.query<{ config: string }, [string]>(`SELECT config FROM scenarios WHERE json_extract(config, '$.metadata.id') = ?`);
  const update = db.query("UPDATE scenarios SET config = json(?) WHERE json_extract(config, '$.metadata.id') = ?") as any;
  const del = db.query("DELETE FROM scenarios WHERE json_extract(config, '$.metadata.id') = ?") as any;
  const softDel = db.query("UPDATE scenarios SET config = json(?) WHERE json_extract(config, '$.metadata.id') = ?") as any;
  const restoreUpd = db.query("UPDATE scenarios SET config = json(?) WHERE json_extract(config, '$.metadata.id') = ?") as any;

  return {
    list() { return selectAll.all().map(r => JSON.parse(r.config)) },
    get(id: string) { const r = selectOne.get(id); return r ? JSON.parse(r.config) : null },
    insert(cfg: any) { insert.run(JSON.stringify(cfg)) },
    update(id: string, cfg: any) { update.run(JSON.stringify(cfg), id); return true },
    delete(id: string) { del.run(id) },
    softDelete(id: string) {
      const cur = selectOne.get(id);
      if (!cur) return false;
      const cfg = JSON.parse(cur.config);
      const tags: string[] = Array.isArray(cfg?.metadata?.tags) ? cfg.metadata.tags.slice() : [];
      if (!tags.includes('deleted')) tags.push('deleted');
      const next = { ...cfg, metadata: { ...(cfg.metadata || {}), tags } };
      softDel.run(JSON.stringify(next), id);
      return true;
    },
    restore(id: string) {
      const cur = selectOne.get(id);
      if (!cur) return false;
      const cfg = JSON.parse(cur.config);
      const tags: string[] = Array.isArray(cfg?.metadata?.tags) ? cfg.metadata.tags.slice() : [];
      const nextTags = tags.filter((t: string) => t !== 'deleted');
      const next = { ...cfg, metadata: { ...(cfg.metadata || {}), tags: nextTags } };
      restoreUpd.run(JSON.stringify(next), id);
      return true;
    }
  }
}
