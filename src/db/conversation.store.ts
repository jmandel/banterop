import type { Database } from 'bun:sqlite';
import type { ConversationMeta, CreateConversationRequest } from '$src/types/conversation.meta';

export interface ConversationRow {
  conversation: number;
  title?: string;
  description?: string;
  scenarioId?: string;
  metaJson: string;  // JSON string of {agents, config, custom}
  status: 'active' | 'completed';
  createdAt: string;
  updatedAt: string;
}

export interface ConversationWithMeta extends ConversationRow {
  metadata: ConversationMeta;
}

export type CreateConversationParams = CreateConversationRequest;

export interface ListConversationsParams {
  status?: 'active' | 'completed';
  scenarioId?: string;
  limit?: number;
  offset?: number;
}

export class ConversationStore {
  constructor(private db: Database) {}

  create(params: CreateConversationParams): number {
    const metadata: ConversationMeta = {
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.scenarioId !== undefined ? { scenarioId: params.scenarioId } : {}),
      agents: params.agents || [],
      ...(params.config !== undefined ? { config: params.config } : {}),
      ...(params.custom !== undefined ? { custom: params.custom } : {}),
    };
    
    const stmt = this.db.prepare(
      `INSERT INTO conversations (title, description, scenario_id, meta_json, status)
       VALUES (?, ?, ?, ?, 'active')`
    );
    const info = stmt.run(
      params.title ?? null,
      params.description ?? null,
      params.scenarioId ?? null,
      JSON.stringify({ agents: metadata.agents, config: metadata.config, custom: metadata.custom })
    );
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
        `SELECT conversation, title, description, scenario_id as scenarioId,
                meta_json as metaJson, status,
                created_at as createdAt, updated_at as updatedAt
         FROM conversations WHERE conversation = ?`
      )
      .get(conversation) as ConversationRow | undefined;
    return row || null;
  }
  
  getWithMetadata(conversation: number): ConversationWithMeta | null {
    const row = this.get(conversation);
    if (!row) return null;
    
    const metaData = row.metaJson ? JSON.parse(row.metaJson) : {};
    const metadata: ConversationMeta = {
      ...(row.title !== undefined && row.title !== null ? { title: row.title } : {}),
      ...(row.description !== undefined && row.description !== null ? { description: row.description } : {}),
      ...(row.scenarioId !== undefined && row.scenarioId !== null ? { scenarioId: row.scenarioId } : {}),
      agents: metaData.agents || [],
      ...(metaData.config !== undefined ? { config: metaData.config } : {}),
      ...(metaData.custom !== undefined ? { custom: metaData.custom } : {}),
    };
    
    return { ...row, metadata };
  }

  list(params: ListConversationsParams) {
    const { status, scenarioId, limit = 50, offset = 0 } = params;
    const wh: string[] = [];
    const args: (string | number)[] = [];
    if (status) {
      wh.push('status = ?');
      args.push(status);
    }
    if (scenarioId) {
      wh.push('scenario_id = ?');
      args.push(scenarioId);
    }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    args.push(limit, offset);
    const rows = this.db
      .prepare(
        `SELECT conversation, title, description, scenario_id as scenarioId,
                meta_json as metaJson, status,
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