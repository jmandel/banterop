import type { Database } from 'bun:sqlite';
import { allocNextEvent } from '$src/lib/utils/id-alloc';
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

      // Turn allocation - REQUIRE explicit turn numbers to avoid bugs
      let turn = input.turn;
      if (turn === undefined) {
        if (input.type === 'system') {
          // System events use an out-of-band lane: turn 0
          turn = 0;
        } else {
          // FAIL LOUDLY - turn number is required for messages and traces
          throw new Error(
            `Turn number is REQUIRED for ${input.type} events. ` +
            `Event type: ${input.type}, Agent: ${input.agentId}, Conversation: ${input.conversation}. ` +
            `This is a bug - the orchestrator should always provide explicit turn numbers.`
          );
        }
      } else {
        // If turn is explicitly provided, reject writes to closed turns for normal turns (> 0)
        if (turn !== 0) {
          const closed = this.isTurnClosed(input.conversation, turn);
          if (closed) throw new Error(`Turn ${turn} already finalized - cannot append more events`);
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
               FROM conversation_events WHERE conversation = ? AND seq = ?`
            )
            .get(input.conversation, existingSeq) as AppendEventResult | undefined;
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

      // Allocate per-conversation seq
      const nextSeqRow = this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM conversation_events WHERE conversation = ?`)
        .get(input.conversation) as { nextSeq: number };
      const seq = nextSeqRow?.nextSeq || 1;

      // Insert event row (ts will use the default from schema with millisecond precision)
      const insert = this.db.prepare(
        `INSERT INTO conversation_events
         (conversation, turn, event, seq, type, payload, finality, agent_id)
         VALUES (?,?,?,?,?,?,?,?)`
      );
      insert.run(
        input.conversation,
        turn,
        eventId,
        seq,
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

  getEventBySeq(conversation: number, seq: number): UnifiedEvent | null {
    const row = this.db
      .prepare(
        `SELECT conversation, turn, event, type, payload, finality, ts, agent_id as agentId, seq
         FROM conversation_events
         WHERE conversation = ? AND seq = ?`
      )
      .get(conversation, seq) as
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

  getEventsSince(conversation: number, sinceSeq?: number): UnifiedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT conversation, turn, event, type, payload, finality, ts, agent_id as agentId, seq
         FROM conversation_events
         WHERE conversation = ?
         ${sinceSeq !== undefined ? 'AND seq > ?' : ''}
         ORDER BY seq ASC`
      )
      .all(
        ...(sinceSeq !== undefined ? [conversation, sinceSeq] : [conversation])
      ) as Array<{
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

  getEventsPage(conversation: number, afterSeq?: number, limit: number = 200): UnifiedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT conversation, turn, event, type, payload, finality, ts, agent_id as agentId, seq
         FROM conversation_events
         WHERE conversation = ?
         ${afterSeq !== undefined ? 'AND seq > ?' : ''}
         ORDER BY seq ASC
         LIMIT ?`
      )
      .all(...(afterSeq !== undefined ? [conversation, afterSeq, limit] : [conversation, limit])) as Array<{
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

    return rows.map(r => ({
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

  // Get conversation head metadata for CAS preconditions
  getHead(conversation: number): { lastTurn: number; lastClosedSeq: number; hasOpenTurn: boolean } {
    // Determine the highest non-system turn seen (messages or traces only)
    const lastTurnRow = this.db
      .prepare(`
        SELECT COALESCE(MAX(turn), 0) AS lastTurn
        FROM conversation_events
        WHERE conversation = ? AND type IN ('message','trace') AND turn > 0
      `)
      .get(conversation) as { lastTurn: number } | undefined;

    const lastTurn = lastTurnRow?.lastTurn || 0;

    // Get the last message with finality !== 'none' (used as the authoritative close marker)
    const lastClosedMessage = this.db
      .prepare(`
        SELECT seq, turn
        FROM conversation_events
        WHERE conversation = ? AND type = 'message' AND finality != 'none'
        ORDER BY seq DESC
        LIMIT 1
      `)
      .get(conversation) as { seq: number; turn: number } | undefined;

    const lastClosedSeq = lastClosedMessage?.seq || 0;

    // A turn is considered open if we have any non-system activity on that turn
    // and there is no closing message for that turn.
    const hasOpenTurn = lastTurn > 0 && !this.isTurnClosed(conversation, lastTurn);

    return {
      lastTurn,
      lastClosedSeq,
      hasOpenTurn,
    };
  }

  // Check if a turn is closed
  isTurnClosed(conversation: number, turn: number): boolean {
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

  // Mark a turn as closed (update lastClosedSeq)
  markTurnClosed(_conversation: number, _turn: number, _seq: number): void {
    // This is handled automatically when a message with finality is inserted
    // The getHead method will find it dynamically
    // No additional work needed here
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

    const inserted = this.attachments.insertMany({
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
      const pair = inserted[i];
      if (!a || !pair) continue;
      const attachment: NonNullable<MessagePayload['attachments']>[number] = {
        id: pair.id,
        name: a.name,
        contentType: a.contentType,
      };
      // Use the docId assigned/persisted by AttachmentStore (non-null)
      attachment.docId = pair.docId;
      if (a.summary !== undefined) attachment.summary = a.summary;
      attached.push(attachment);
    }

    return {
      ...payload,
      attachments: attached,
    };
  }
}
