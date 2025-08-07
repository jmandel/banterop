import type { Database } from 'bun:sqlite';

export interface IdempotencyRecord {
  conversation: number;
  agentId: string;
  clientRequestId: string;
  seq: number;
}

export interface IdempotencyKey {
  conversation: number;
  agentId: string;
  clientRequestId: string;
}

export class IdempotencyStore {
  constructor(private db: Database) {}

  record(params: IdempotencyRecord) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO idempotency_keys
         (conversation, agent_id, client_request_id, seq)
         VALUES (?,?,?,?)`
      )
      .run(params.conversation, params.agentId, params.clientRequestId, params.seq);
  }

  find(params: IdempotencyKey): number | null {
    const row = this.db
      .prepare(
        `SELECT seq FROM idempotency_keys
         WHERE conversation = ? AND agent_id = ? AND client_request_id = ?`
      )
      .get(params.conversation, params.agentId, params.clientRequestId) as { seq: number } | undefined;
    return row?.seq ?? null;
  }
}