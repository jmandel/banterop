import { Database } from 'bun:sqlite'
import type { Env } from './env'
import type { A2AStatus } from '../../shared/a2a-types'

export type TaskState = A2AStatus
// Parsimonious task row: identity only; role is derivable from task_id; state/message are computed from events/messages
export type TaskRow = { task_id:string; pair_id:string; epoch:number }
export type PairRow = { pair_id:string; epoch:number; metadata:string|null }

export type MessageRow = { pair_id: string; epoch: number; author: 'init'|'resp'; json: string };

export type Persistence = {
  createPair(pairId:string): void
  getPair(pairId:string): PairRow | null
  setPairEpoch(pairId:string, epoch:number): void

  getTask(taskId:string): TaskRow | null
  upsertTask(row: TaskRow): void
  createEpochTasks(pairId:string, epoch:number): void

  insertMessage(row: MessageRow): void
  listMessages(pairId: string, epoch: number, opts?: { order?: 'ASC'|'DESC'; limit?: number }): Array<MessageRow>
  lastMessage(pairId: string, epoch: number): MessageRow | null
  // Cross-epoch helpers
  lastMessageAny(pairId: string): { author:'init'|'resp'; json:string; epoch:number; created_at:number|null } | null
  countMessages(pairId: string): number
  countMessagesSince(pairId: string, sinceMs: number): number
  lastActivityTs(pairId: string): number | null
  listPairs(): PairRow[]

  close(): void
}

export function createPersistenceFromDb(db: Database): Persistence {
  // Ensure schema is created and migrated before preparing statements.
  // This avoids referencing columns (e.g., created_at) that may not exist yet
  // in older deployments.
  ensureSchema(db);

  const createPairStmt = db.query(`INSERT INTO pairs (pair_id, epoch, metadata) VALUES (?, 0, NULL)`) as any
  const getPairStmt   = db.query<PairRow, [string]>(`SELECT pair_id, epoch, metadata FROM pairs WHERE pair_id = ?`)
  const setEpochStmt  = db.query(`UPDATE pairs SET epoch = ? WHERE pair_id = ?`) as any

  const getTaskStmt   = db.query<TaskRow, [string]>(`SELECT task_id, pair_id, epoch FROM tasks WHERE task_id = ?`)
  const upTaskStmt    = db.query(`INSERT INTO tasks (task_id, pair_id, epoch) VALUES (?, ?, ?)
                                  ON CONFLICT(task_id) DO NOTHING`) as any
  const createTaskStmt= db.query(`INSERT INTO tasks (task_id, pair_id, epoch) VALUES (?, ?, ?)`) as any
  const insMsg        = db.query(`INSERT INTO messages (pair_id, epoch, author, json) VALUES (?, ?, ?, json(?))`) as any
  const selLastMsg    = db.query<{ author:string; json:string }, [string, number]>(
    `SELECT author, json FROM messages WHERE pair_id = ? AND epoch = ? ORDER BY rowid DESC LIMIT 1`
  )
  const selLastAny    = db.query<{ author:string; json:string; epoch:number; created_at:number|null }, [string]>(
    `SELECT author, json, epoch, created_at FROM messages WHERE pair_id = ? ORDER BY rowid DESC LIMIT 1`
  )
  const cntAllByPair  = db.query<{ n:number }, [string]>(`SELECT COUNT(*) as n FROM messages WHERE pair_id = ?`)
  const cntSinceByPair= db.query<{ n:number }, [string, number]>(`SELECT COUNT(*) as n FROM messages WHERE pair_id = ? AND COALESCE(created_at, 0) >= ?`)
  const lastTsByPair  = db.query<{ ts:number|null }, [string]>(`SELECT MAX(created_at) as ts FROM messages WHERE pair_id = ?`)
  const selListAsc    = db.query<{ author:string; json:string }, [string, number, number]>(
    `SELECT author, json FROM messages WHERE pair_id = ? AND epoch = ? ORDER BY rowid ASC LIMIT ?`
  )
  const selListDesc   = db.query<{ author:string; json:string }, [string, number, number]>(
    `SELECT author, json FROM messages WHERE pair_id = ? AND epoch = ? ORDER BY rowid DESC LIMIT ?`
  )
  const listPairsStmt = db.query<PairRow, []>(`SELECT pair_id, epoch, metadata FROM pairs`)

  function createPair(pairId:string) { try { createPairStmt.run(pairId) } catch {} }
  function getPair(pairId:string): PairRow | null { const row = getPairStmt.get(pairId); return row || null }
  function setPairEpoch(pairId:string, epoch:number) { setEpochStmt.run(epoch, pairId) }

  function getTask(taskId:string): TaskRow | null { const row = getTaskStmt.get(taskId); return row || null }
  function upsertTask(row: TaskRow) { upTaskStmt.run(row.task_id, row.pair_id, row.epoch) }
  function createEpochTasks(pairId:string, epoch:number) {
    createTaskStmt.run(`init:${pairId}#${epoch}`, pairId, epoch)
    createTaskStmt.run(`resp:${pairId}#${epoch}`, pairId, epoch)
  }

  function insertMessage(row: MessageRow) { insMsg.run(row.pair_id, row.epoch, row.author, row.json) }
  function listMessages(pairId: string, epoch: number, opts?: { order?: 'ASC'|'DESC'; limit?: number }): Array<MessageRow> {
    const limit = Math.max(0, Math.floor(opts?.limit ?? 10000));
    const order = (opts?.order || 'ASC').toUpperCase();
    const rows = order === 'DESC' ? selListDesc.all(pairId, epoch, limit) : selListAsc.all(pairId, epoch, limit);
    return rows.map(r => ({ pair_id: pairId, epoch, author: (r.author === 'resp' ? 'resp' : 'init') as any, json: r.json }));
  }
  function lastMessage(pairId: string, epoch: number): MessageRow | null {
    const r = selLastMsg.get(pairId, epoch);
    return r ? ({ pair_id: pairId, epoch, author: (r.author === 'resp' ? 'resp' : 'init') as any, json: r.json }) : null;
  }
  function lastMessageAny(pairId: string) {
    const r = selLastAny.get(pairId);
    return r ? ({ author: (r.author === 'resp' ? 'resp' : 'init') as any, json: r.json, epoch: r.epoch, created_at: (typeof r.created_at === 'number' ? r.created_at : null) }) : null;
  }
  function countMessages(pairId: string): number { const r = cntAllByPair.get(pairId) as any; return (r?.n ?? 0) as number }
  function countMessagesSince(pairId: string, sinceMs: number): number { const r = cntSinceByPair.get(pairId, sinceMs) as any; return (r?.n ?? 0) as number }
  function lastActivityTs(pairId: string): number | null { const r = lastTsByPair.get(pairId) as any; return (typeof r?.ts === 'number' ? r.ts : null) }
  function listPairs(): PairRow[] { return listPairsStmt.all() }

  function close() { try { db.close() } catch {} }

  return { createPair, getPair, setPairEpoch, getTask, upsertTask, createEpochTasks, insertMessage, listMessages, lastMessage, lastMessageAny, countMessages, countMessagesSince, lastActivityTs, listPairs, close }
}

export function createPersistence(env: Env): Persistence {
  const db = new Database(env.BANTEROP_DB || ':memory:')
  db.exec('PRAGMA journal_mode = WAL;')
  return createPersistenceFromDb(db)
}

// --- Schema management: versioned, idempotent migrations ---
function ensureSchema(db: Database): void {
  // Helper: read PRAGMA user_version
  function getUserVersion(): number {
    try {
      const row: any = (db.query('PRAGMA user_version') as any).get();
      const v = (row && (row.user_version ?? row.USER_VERSION ?? row[Object.keys(row)[0]])) as number | undefined;
      return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
    } catch { return 0; }
  }
  function setUserVersion(v: number) { try { db.exec(`PRAGMA user_version = ${Math.max(0, Math.floor(v))}`) } catch {} }
  function hasColumn(table: string, col: string): boolean {
    try {
      const q = db.query(`PRAGMA table_info(${table})`) as any;
      const rows = q.all();
      return Array.isArray(rows) && rows.some((r: any) => String(r?.name || '').toLowerCase() === col.toLowerCase());
    } catch { return false; }
  }
  function hasIndex(table: string, idxName: string): boolean {
    try {
      const q = db.query(`PRAGMA index_list(${table})`) as any;
      const rows = q.all();
      return Array.isArray(rows) && rows.some((r: any) => String(r?.name || '').toLowerCase() === idxName.toLowerCase());
    } catch { return false; }
  }

  let v = getUserVersion();
  // v0: legacy (no user_version set). v1: baseline tables created. v2+: explicit migrations
  try { console.info(`[db] schema user_version=${v}`) } catch {}
  db.exec('BEGIN');

  try {
    if (v < 1) {
      try { console.info('[db] migrating v0 → v1 (baseline tables)') } catch {}
      // If tables are missing, ensure they exist (no-ops if present). Baseline.
      db.exec(`
        CREATE TABLE IF NOT EXISTS pairs (
          pair_id TEXT PRIMARY KEY,
          epoch INTEGER NOT NULL,
          metadata TEXT
        );
        CREATE TABLE IF NOT EXISTS tasks (
          task_id TEXT PRIMARY KEY,
          pair_id TEXT NOT NULL,
          epoch INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          pair_id  TEXT    NOT NULL,
          epoch    INTEGER NOT NULL,
          author   TEXT    NOT NULL CHECK(author IN ('init','resp')),
          json     TEXT    NOT NULL,
          CHECK (json_valid(json)),
          CHECK (json_extract(json,'$.messageId') IS NOT NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages((json_extract(json,'$.messageId')));
        CREATE INDEX IF NOT EXISTS idx_messages_pair_epoch ON messages(pair_id, epoch);
      `);
      v = 1; setUserVersion(1);
      try { console.info('[db] migration v1 applied') } catch {}
    }
    if (v < 2) {
      try { console.info('[db] migrating v1 → v2 (messages.created_at + idx)') } catch {}
      // Add created_at column and index; backfill nulls to current time
      if (!hasColumn('messages', 'created_at')) {
        try { db.exec(`ALTER TABLE messages ADD COLUMN created_at INTEGER`); } catch {}
        try { db.exec(`UPDATE messages SET created_at = CAST(strftime('%s','now') AS INTEGER)*1000 WHERE created_at IS NULL`); } catch {}
      }
      if (!hasIndex('messages', 'idx_messages_pair_time')) {
        try { db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_pair_time ON messages(pair_id, created_at)`); } catch {}
      }
      v = 2; setUserVersion(2);
      try { console.info('[db] migration v2 applied') } catch {}
    }
  } catch (e:any) {
    try { db.exec('ROLLBACK') } catch {}
    throw new Error(`Database migration failed: ${String(e?.message || e)}`);
  }
  db.exec('COMMIT');
  try { console.info(`[db] schema ready at user_version=${v}`) } catch {}
}
