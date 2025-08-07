import type { Database } from 'bun:sqlite';

export interface ConversationRow {
  conversation: number;
  tenantId?: string;
  title?: string;
  description?: string;
  status: 'active' | 'completed';
  createdAt: string;
  updatedAt: string;
}

export interface CreateConversationParams {
  tenantId?: string;
  title?: string;
  description?: string;
}

export interface ListConversationsParams {
  tenantId?: string;
  status?: 'active' | 'completed';
  limit?: number;
  offset?: number;
}

export class ConversationStore {
  constructor(private db: Database) {}

  create(params: CreateConversationParams): number {
    const stmt = this.db.prepare(
      `INSERT INTO conversations (tenant_id, title, description, status)
       VALUES (?,?,?, 'active')`
    );
    const info = stmt.run(params.tenantId ?? null, params.title ?? null, params.description ?? null);
    return Number(info.lastInsertRowid);
  }

  complete(conversation: number) {
    this.db
      .prepare(`UPDATE conversations SET status='completed' WHERE conversation = ?`)
      .run(conversation);
  }

  get(conversation: number): ConversationRow | null {
    const row = this.db
      .prepare(
        `SELECT conversation, tenant_id as tenantId, title, description, status,
                created_at as createdAt, updated_at as updatedAt
         FROM conversations WHERE conversation = ?`
      )
      .get(conversation) as ConversationRow | undefined;
    return row || null;
  }

  list(params: ListConversationsParams) {
    const { tenantId, status, limit = 50, offset = 0 } = params;
    const wh: string[] = [];
    const args: (string | number)[] = [];
    if (tenantId) {
      wh.push('tenant_id = ?');
      args.push(tenantId);
    }
    if (status) {
      wh.push('status = ?');
      args.push(status);
    }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    args.push(limit, offset);
    const rows = this.db
      .prepare(
        `SELECT conversation, tenant_id as tenantId, title, description, status,
                created_at as createdAt, updated_at as updatedAt
         FROM conversations
         ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...args) as ConversationRow[];
    return rows;
  }
}