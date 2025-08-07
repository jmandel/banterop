import type { Database } from 'bun:sqlite';

export function allocNextTurn(db: Database, conversation: number): number {
  const stmt = db.prepare(
    `SELECT COALESCE(MAX(turn), 0) as maxTurn
     FROM conversation_events
     WHERE conversation = ?`
  );
  const row = stmt.get(conversation) as { maxTurn: number } | null;
  return Number(row?.maxTurn || 0) + 1;
}

export function allocNextEvent(db: Database, conversation: number, turn: number): number {
  const stmt = db.prepare(
    `SELECT COALESCE(MAX(event), 0) as maxEvent
     FROM conversation_events
     WHERE conversation = ? AND turn = ?`
  );
  const row = stmt.get(conversation, turn) as { maxEvent: number } | null;
  return Number(row?.maxEvent || 0) + 1;
}