import { Database } from 'bun:sqlite'
import type { Env } from './env'

export type TaskState = 'submitted'|'working'|'input-required'|'completed'|'canceled'|'failed'|'rejected'|'auth-required'|'unknown'
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
  listPairs(): PairRow[]

  close(): void
}

export function createPersistenceFromDb(db: Database): Persistence {
  db.exec(`
    PRAGMA journal_mode = WAL;
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
  `)

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
  function listPairs(): PairRow[] { return listPairsStmt.all() }

  function close() { try { db.close() } catch {} }

  return { createPair, getPair, setPairEpoch, getTask, upsertTask, createEpochTasks, insertMessage, listMessages, lastMessage, listPairs, close }
}

export function createPersistence(env: Env): Persistence {
  const db = new Database(env.FLIPPROXY_DB || ':memory:')
  db.exec('PRAGMA journal_mode = WAL;')
  return createPersistenceFromDb(db)
}
