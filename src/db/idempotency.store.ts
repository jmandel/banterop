import type { Database } from 'bun:sqlite';

export interface IdempotencyRecord {
  tenantId?: string;
  conversation: number;
  agentId: string;
  clientRequestId: string;
  seq: number;
}

export interface IdempotencyKey {
  tenantId?: string;
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
         (tenant_id, conversation, agent_id, client_request_id, seq)
         VALUES (?,?,?,?,?)`
      )
      .run(params.tenantId ?? null, params.conversation, params.agentId, params.clientRequestId, params.seq);
  }

  find(params: IdempotencyKey): number | null {
    const row = this.db
      .prepare(
        `SELECT seq FROM idempotency_keys
         WHERE tenant_id IS ? AND conversation = ? AND agent_id = ? AND client_request_id = ?`
      )
      .get(params.tenantId ?? null, params.conversation, params.agentId, params.clientRequestId) as { seq: number } | undefined;
    return row?.seq ?? null;
  }
}