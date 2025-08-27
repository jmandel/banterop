import { Database } from 'bun:sqlite'
import type { Env } from './env'

export type TaskState = 'submitted'|'working'|'input-required'|'completed'|'canceled'
// Parsimonious task row: identity only; role is derivable from task_id; state/message are computed from events/messages
export type TaskRow = { task_id:string; pair_id:string; epoch:number }
export type PairRow = { pair_id:string; epoch:number; metadata:string|null }

export type Persistence = {
  createPair(pairId:string): void
  getPair(pairId:string): PairRow | null
  setPairEpoch(pairId:string, epoch:number): void

  getTask(taskId:string): TaskRow | null
  upsertTask(row: TaskRow): void
  createEpochTasks(pairId:string, epoch:number): void

  close(): void
}

export function createPersistence(env: Env): Persistence {
  const db = new Database(env.FLIPPROXY_DB || ':memory:')
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
  `)

  const createPairStmt = db.query(`INSERT INTO pairs (pair_id, epoch, metadata) VALUES (?, 0, NULL)`) as any
  const getPairStmt   = db.query<PairRow, [string]>(`SELECT pair_id, epoch, metadata FROM pairs WHERE pair_id = ?`)
  const setEpochStmt  = db.query(`UPDATE pairs SET epoch = ? WHERE pair_id = ?`) as any

  const getTaskStmt   = db.query<TaskRow, [string]>(`SELECT task_id, pair_id, epoch FROM tasks WHERE task_id = ?`)
  const upTaskStmt    = db.query(`INSERT INTO tasks (task_id, pair_id, epoch) VALUES (?, ?, ?)
                                  ON CONFLICT(task_id) DO NOTHING`) as any
  const createTaskStmt= db.query(`INSERT INTO tasks (task_id, pair_id, epoch) VALUES (?, ?, ?)`) as any

  function createPair(pairId:string) { try { createPairStmt.run(pairId) } catch {} }
  function getPair(pairId:string): PairRow | null { const row = getPairStmt.get(pairId); return row || null }
  function setPairEpoch(pairId:string, epoch:number) { setEpochStmt.run(epoch, pairId) }

  function getTask(taskId:string): TaskRow | null { const row = getTaskStmt.get(taskId); return row || null }
  function upsertTask(row: TaskRow) { upTaskStmt.run(row.task_id, row.pair_id, row.epoch) }
  function createEpochTasks(pairId:string, epoch:number) {
    createTaskStmt.run(`init:${pairId}#${epoch}`, pairId, epoch)
    createTaskStmt.run(`resp:${pairId}#${epoch}`, pairId, epoch)
  }

  function close() { try { db.close() } catch {} }

  return { createPair, getPair, setPairEpoch, getTask, upsertTask, createEpochTasks, close }
}
