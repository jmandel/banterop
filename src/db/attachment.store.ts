import { randomUUID } from 'crypto';
import type { Database } from 'bun:sqlite';
import type { AttachmentRow } from '$src/types/event.types';

export interface AttachmentInput {
  id?: string;
  docId?: string;
  name: string;
  contentType: string;
  content: string;
  summary?: string;
}

export interface AttachmentInsertParams {
  conversation: number;
  turn: number;
  event: number;
  createdByAgentId: string;
  items: AttachmentInput[];
}

export class AttachmentStore {
  constructor(private db: Database) {}

  insertMany(params: AttachmentInsertParams): string[] {
    if (!params.items?.length) return [];

    const ids: string[] = [];
    const stmt = this.db.prepare(
      `INSERT INTO attachments
       (id, conversation, turn, event, doc_id, name, content_type, content, summary, created_by_agent_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );

    const tx = this.db.transaction(() => {
      for (const item of params.items) {
        const id = item.id ?? `att_${randomUUID()}`;
        stmt.run(
          id,
          params.conversation,
          params.turn,
          params.event,
          item.docId ?? null,
          item.name,
          item.contentType,
          item.content,
          item.summary ?? null,
          params.createdByAgentId
        );
        ids.push(id);
      }
    });

    tx();
    return ids;
  }

  getById(id: string): AttachmentRow | null {
    const row = this.db
      .prepare(
        `SELECT id, conversation, turn, event, doc_id as docId, name, content_type as contentType,
                content, summary, created_by_agent_id as createdByAgentId, created_at as createdAt
         FROM attachments WHERE id = ?`
      )
      .get(id) as AttachmentRow | undefined;
    return row || null;
  }

  listByConversation(conversation: number): AttachmentRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation, turn, event, doc_id as docId, name, content_type as contentType,
                content, summary, created_by_agent_id as createdByAgentId, created_at as createdAt
         FROM attachments WHERE conversation = ?
         ORDER BY created_at ASC`
      )
      .all(conversation) as AttachmentRow[];
    return rows;
  }

  getByDocId(conversation: number, docId: string): AttachmentRow | null {
    const row = this.db
      .prepare(
        `SELECT id, conversation, turn, event, doc_id as docId, name, content_type as contentType,
                content, summary, created_by_agent_id as createdByAgentId, created_at as createdAt
         FROM attachments WHERE conversation = ? AND doc_id = ? LIMIT 1`
      )
      .get(conversation, docId) as AttachmentRow | undefined;
    return row || null;
  }
}