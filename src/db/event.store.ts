import type { Database } from 'bun:sqlite';
import { allocNextEvent, allocNextTurn } from '$src/lib/utils/id-alloc';
import type {
  AppendEventInput,
  AppendEventResult,
  UnifiedEvent,
  MessagePayload,
  Finality,
} from '$src/types/event.types';
import { AttachmentStore, type AttachmentInput } from './attachment.store';
import { ConversationStore } from './conversation.store';
import { IdempotencyStore } from './idempotency.store';

export class EventStore {
  private attachments: AttachmentStore;
  private conversations: ConversationStore;
  private idempotency: IdempotencyStore;

  constructor(private db: Database) {
    this.attachments = new AttachmentStore(db);
    this.conversations = new ConversationStore(db);
    this.idempotency = new IdempotencyStore(db);
  }

  appendEvent<T = unknown>(input: AppendEventInput<T>): AppendEventResult {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      this.ensureConversationExists(input.conversation);

      // Check conversation not finalized
      const lastFinal = this.getLastConversationFinality(input.conversation);
      if (lastFinal === 'conversation') {
        throw new Error('Conversation is finalized');
      }

      // Validate finality vs type
      if ((input.type === 'trace' || input.type === 'system') && input.finality !== 'none') {
        throw new Error('Only message events may set finality to turn or conversation');
      }

      // Turn allocation
      let turn = input.turn;
      if (turn === undefined) {
        if (input.type === 'system') {
          // System events use an out-of-band lane: turn 0
          turn = 0;
        } else if (input.type === 'message' || input.type === 'trace') {
          turn = allocNextTurn(this.db, input.conversation);
        } else {
          throw new Error('Only message or trace events may start a new turn');
        }
      } else {
        // If turn is explicitly provided, reject writes to closed turns for normal turns (> 0)
        if (turn !== 0) {
          const closed = this.isTurnClosed(input.conversation, turn);
          if (closed) throw new Error('Turn already finalized');
        }
      }

      // Event allocation
      const eventId = allocNextEvent(this.db, input.conversation, turn);

      // Idempotency (optional clientRequestId on message/trace)
      const clientReqId =
        (input.type === 'message' && (input.payload as MessagePayload).clientRequestId) ||
        (input.type === 'trace' && 'clientRequestId' in (input.payload as object) && (input.payload as {clientRequestId?: string}).clientRequestId) ||
        undefined;

      if (clientReqId) {
        const existingSeq = this.idempotency.find({
          conversation: input.conversation,
          agentId: input.agentId,
          clientRequestId: clientReqId,
        });
        if (existingSeq) {
          // Return the existing seq by looking it up
          const existing = this.db
            .prepare(
              `SELECT conversation, turn, event, ts, seq
               FROM conversation_events WHERE seq = ?`
            )
            .get(existingSeq) as AppendEventResult | undefined;
          if (existing) {
            this.db.exec('COMMIT;');
            return existing;
          }
        }
      }

      // We need to first insert the event, then handle attachments if present
      let payloadToStore: unknown = input.payload;
      
      // For messages with attachments, we'll store a placeholder first, then update
      if (input.type === 'message' && (input.payload as MessagePayload).attachments?.length) {
        // Store without attachments initially
        const tempPayload = { ...(input.payload as MessagePayload) };
        delete tempPayload.attachments;
        payloadToStore = tempPayload;
      }

      // Insert event row
      const insert = this.db.prepare(
        `INSERT INTO conversation_events
         (conversation, turn, event, type, payload, finality, ts, agent_id)
         VALUES (?,?,?,?,?,?,datetime('now'),?)`
      );
      insert.run(
        input.conversation,
        turn,
        eventId,
        input.type,
        JSON.stringify(payloadToStore),
        input.finality,
        input.agentId
      );

      // Now handle attachments if present
      if (input.type === 'message' && (input.payload as MessagePayload).attachments?.length) {
        const processedPayload = this.processMessageAttachments(
          input.conversation,
          turn,
          eventId,
          input.agentId,
          input.payload as MessagePayload
        );
        // Update the event with the processed payload
        this.db.prepare(
          `UPDATE conversation_events 
           SET payload = ?
           WHERE conversation = ? AND turn = ? AND event = ?`
        ).run(JSON.stringify(processedPayload), input.conversation, turn, eventId);
      }

      // Read back seq + ts
      const row = this.db
        .prepare(
          `SELECT seq, ts
           FROM conversation_events
           WHERE conversation = ? AND turn = ? AND event = ?`
        )
        .get(input.conversation, turn, eventId) as { seq: number; ts: string };

      // If conversation finality set, mark conversation status
      if (input.type === 'message' && input.finality === 'conversation') {
        this.conversations.complete(input.conversation);
      }

      // Idempotency record
      if (clientReqId) {
        this.idempotency.record({
          conversation: input.conversation,
          agentId: input.agentId,
          clientRequestId: clientReqId,
          seq: row.seq,
        });
      }

      this.db.exec('COMMIT;');
      return {
        conversation: input.conversation,
        turn,
        event: eventId,
        seq: row.seq,
        ts: row.ts,
      };
    } catch (e) {
      this.db.exec('ROLLBACK;');
      throw e;
    }
  }

  getEventBySeq(seq: number): UnifiedEvent | null {
    const row = this.db
      .prepare(
        `SELECT conversation, turn, event, type, payload, finality, ts, agent_id as agentId, seq
         FROM conversation_events
         WHERE seq = ?`
      )
      .get(seq) as
        | {
            conversation: number;
            turn: number;
            event: number;
            type: string;
            payload: string;
            finality: string;
            ts: string;
            agentId: string;
            seq: number;
          }
        | undefined;
    if (!row) return null;
    return {
      conversation: row.conversation,
      turn: row.turn,
      event: row.event,
      type: row.type as UnifiedEvent['type'],
      payload: JSON.parse(row.payload),
      finality: row.finality as Finality,
      ts: row.ts,
      agentId: row.agentId,
      seq: row.seq,
    };
  }

  getEvents(conversation: number): UnifiedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT conversation, turn, event, type, payload, finality, ts, agent_id as agentId, seq
         FROM conversation_events
         WHERE conversation = ?
         ORDER BY turn ASC, event ASC`
      )
      .all(conversation) as Array<{
        conversation: number;
        turn: number;
        event: number;
        type: string;
        payload: string;
        finality: string;
        ts: string;
        agentId: string;
        seq: number;
      }>;

    return rows.map((r) => ({
      conversation: r.conversation,
      turn: r.turn,
      event: r.event,
      type: r.type as UnifiedEvent['type'],
      payload: JSON.parse(r.payload),
      finality: r.finality as Finality,
      ts: r.ts,
      agentId: r.agentId,
      seq: r.seq,
    }));
  }

  getConversationStatus(conversation: number): 'active' | 'completed' {
    const row = this.db
      .prepare(`SELECT status FROM conversations WHERE conversation = ?`)
      .get(conversation) as { status: string } | undefined;
    return (row?.status as 'active' | 'completed') || 'active';
  }

  // Helpers

  private ensureConversationExists(conversation: number) {
    const row = this.db
      .prepare(`SELECT 1 FROM conversations WHERE conversation = ?`)
      .get(conversation);
    if (!row) {
      // Create a shell conversation row
      this.db
        .prepare(
          `INSERT INTO conversations (conversation, status) VALUES (?, 'active')`
        )
        .run(conversation);
    }
  }

  private getLastConversationFinality(conversation: number): Finality | 'none' {
    const row = this.db
      .prepare(
        `SELECT finality
         FROM conversation_events
         WHERE conversation = ?
         ORDER BY seq DESC
         LIMIT 1`
      )
      .get(conversation) as { finality: string } | undefined;
    return (row?.finality as Finality) || 'none';
  }

  private isTurnClosed(conversation: number, turn: number): boolean {
    const row = this.db
      .prepare(
        `SELECT finality
         FROM conversation_events
         WHERE conversation = ? AND turn = ? AND type = 'message'
         ORDER BY event DESC
         LIMIT 1`
      )
      .get(conversation, turn) as { finality: string } | undefined;
    return row?.finality === 'turn' || row?.finality === 'conversation';
  }

  private processMessageAttachments(
    conversation: number,
    turn: number,
    event: number,
    agentId: string,
    payload: MessagePayload
  ): MessagePayload {
    const items = payload.attachments?.length ? payload.attachments : [];
    if (!items || items.length === 0) return payload;

    const attachmentItems: AttachmentInput[] = [];
    for (const a of items) {
      const item: AttachmentInput = {
        name: a.name,
        contentType: a.contentType,
        content: a.content || '',
      };
      if (a.id !== undefined) item.id = a.id;
      if (a.docId !== undefined) item.docId = a.docId;
      if (a.summary !== undefined) item.summary = a.summary;
      attachmentItems.push(item);
    }

    const ids = this.attachments.insertMany({
      conversation,
      turn,
      event,
      createdByAgentId: agentId,
      items: attachmentItems,
    });

    // Replace attachments content in the payload with refs (id/docId)
    const attached: MessagePayload['attachments'] = [];
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      const attachmentId = ids[i];
      if (!a || !attachmentId) continue;
      const attachment: NonNullable<MessagePayload['attachments']>[number] = {
        id: attachmentId,
        name: a.name,
        contentType: a.contentType,
      };
      if (a.docId !== undefined) attachment.docId = a.docId;
      if (a.summary !== undefined) attachment.summary = a.summary;
      attached.push(attachment);
    }

    return {
      ...payload,
      attachments: attached,
    };
  }
}