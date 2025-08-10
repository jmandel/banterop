import type { Database } from 'bun:sqlite';
import type { ConversationMeta, CreateConversationRequest } from '$src/types/conversation.meta';

// This is the main Conversation type - always includes parsed metadata
export interface Conversation {
  conversation: number;
  status: 'active' | 'completed';
  metadata: ConversationMeta;
  createdAt: string;
  updatedAt: string;
}

// Internal type for raw DB rows
interface ConversationRow {
  conversation: number;
  status: 'active' | 'completed';
  metaJson: string;
  createdAt: string;
  updatedAt: string;
}

export type CreateConversationParams = CreateConversationRequest;

export interface ListConversationsParams {
  status?: 'active' | 'completed';
  scenarioId?: string;
  limit?: number;
  offset?: number;
  updatedAfter?: string; // ISO timestamp filter
}

export class ConversationStore {
  constructor(private db: Database) {}

  updateMeta(conversationId: number, metadata: ConversationMeta): void {
    // Ensure metaVersion is set
    const metaWithVersion = {
      ...metadata,
      metaVersion: metadata.metaVersion || 1
    };
    
    this.db.prepare(`
      UPDATE conversations
      SET meta_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE conversation = ?
    `).run(JSON.stringify(metaWithVersion), conversationId);
  }

  create(params: CreateConversationParams): number {
    // Ensure metaVersion is set
    const metadata: ConversationMeta = {
      ...params.meta,
      metaVersion: params.meta.metaVersion || 1
    };
    
    const stmt = this.db.prepare(
      `INSERT INTO conversations (meta_json, status)
       VALUES (?, 'active')`
    );
    const info = stmt.run(JSON.stringify(metadata));
    return Number(info.lastInsertRowid);
  }

  complete(conversation: number) {
    this.db
      .prepare(`UPDATE conversations SET status='completed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation = ?`)
      .run(conversation);
  }

  get(conversation: number): Conversation | null {
    const row = this.db
      .prepare(
        `SELECT conversation, status,
                meta_json as metaJson,
                created_at as createdAt, updated_at as updatedAt
         FROM conversations WHERE conversation = ?`
      )
      .get(conversation) as ConversationRow | undefined;
    
    if (!row) return null;
    
    return {
      conversation: row.conversation,
      status: row.status,
      metadata: JSON.parse(row.metaJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }
  
  // Alias for backward compatibility if needed
  getWithMetadata(conversation: number): Conversation | null {
    return this.get(conversation);
  }

  list(params: ListConversationsParams = {}): Conversation[] {
    const { status, scenarioId, limit = 50, offset = 0, updatedAfter } = params;
    const wh: string[] = [];
    const args: (string | number)[] = [];
    
    if (status) {
      wh.push('status = ?');
      args.push(status);
    }
    if (scenarioId) {
      // Use JSON extract for scenarioId filtering
      wh.push("json_extract(meta_json, '$.scenarioId') = ?");
      args.push(scenarioId);
    }
    if (updatedAfter) {
      wh.push('updated_at >= ?');
      args.push(updatedAfter);
    }
    
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    args.push(limit, offset);
    
    const rows = this.db
      .prepare(
        `SELECT conversation, status,
                meta_json as metaJson,
                created_at as createdAt, updated_at as updatedAt
         FROM conversations
         ${where}
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...args) as ConversationRow[];
    
    // Always return with parsed metadata
    return rows.map(row => ({
      conversation: row.conversation,
      status: row.status,
      metadata: JSON.parse(row.metaJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }
}
