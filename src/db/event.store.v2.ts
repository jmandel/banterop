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

export class EventStoreV2 {
  private attachments: AttachmentStore;
  private conversations: ConversationStore;
  private idempotency: IdempotencyStore;

  constructor(private db: Database) {
    this.attachments = new AttachmentStore(db);
    this.conversations = new ConversationStore(db);
    this.idempotency = new IdempotencyStore(db);
  }

  /**
   * Allocate the next seq number for a conversation.
   * Each conversation has its own sequence starting at 1.
   */
  private allocNextSeq(conversation: number): number {
    const result = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 as nextSeq 
         FROM conversation_events 
         WHERE conversation = ?`
      )
      .get(conversation) as { nextSeq: number };
    return result.nextSeq;
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

      // Allocate per-conversation seq
      const seq = this.allocNextSeq(input.conversation);

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

      // Insert event row with explicit seq
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

      // Read back ts
      const row = this.db
        .prepare(
          `SELECT ts
           FROM conversation_events
           WHERE conversation = ? AND turn = ? AND event = ?`
        )
        .get(input.conversation, turn, eventId) as { ts: string };

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
          seq: seq,
        });
      }

      this.db.exec('COMMIT;');
      return {
        conversation: input.conversation,
        turn,
        event: eventId,
        seq: seq,
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

  listEvents(conversation: number, options?: { limit?: number }): UnifiedEvent[] {
    const stmt = this.db.prepare(
      `SELECT conversation, turn, event, type, payload, finality, ts, agent_id as agentId, seq
       FROM conversation_events
       WHERE conversation = ?
       ORDER BY seq ASC
       ${options?.limit ? 'LIMIT ?' : ''}`
    );
    const rows = (options?.limit ? stmt.all(conversation, options.limit) : stmt.all(conversation)) as Array<{
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
    return rows.map((row) => ({
      conversation: row.conversation,
      turn: row.turn,
      event: row.event,
      type: row.type as UnifiedEvent['type'],
      payload: JSON.parse(row.payload),
      finality: row.finality as Finality,
      ts: row.ts,
      agentId: row.agentId,
      seq: row.seq,
    }));
  }

  // Helper methods (unchanged logic, but seq is now per-conversation)
  private ensureConversationExists(conversation: number): void {
    const exists = this.conversations.find(conversation);
    if (!exists) {
      throw new Error(`Conversation ${conversation} does not exist`);
    }
  }

  private getLastConversationFinality(conversation: number): Finality | null {
    const row = this.db
      .prepare(
        `SELECT finality FROM conversation_events
         WHERE conversation = ? AND type = 'message'
         ORDER BY seq DESC LIMIT 1`
      )
      .get(conversation) as { finality: string } | undefined;
    return row ? (row.finality as Finality) : null;
  }

  private isTurnClosed(conversation: number, turn: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM conversation_events
         WHERE conversation = ? AND turn = ? AND type = 'message' AND finality IN ('turn','conversation')
         LIMIT 1`
      )
      .get(conversation, turn);
    return !!row;
  }

  // Process message attachments
  private processMessageAttachments(
    conversation: number,
    turn: number,
    event: number,
    agentId: string,
    payload: MessagePayload
  ): MessagePayload {
    if (!payload.attachments?.length) {
      return payload;
    }

    const attachmentInputs: AttachmentInput[] = payload.attachments.map(att => ({
      id: att.id,
      conversation,
      turn,
      event,
      docId: att.docId,
      name: att.name,
      contentType: att.contentType,
      content: att.content || '',
      summary: att.summary,
      createdByAgentId: agentId,
    }));

    const savedAttachments = this.attachments.insertMany(attachmentInputs);

    // Create processed payload with attachment references only
    const processedPayload: MessagePayload = {
      ...payload,
      attachments: savedAttachments.map(att => ({
        id: att.id,
        name: att.name,
        contentType: att.contentType,
        ...(att.summary && { summary: att.summary }),
        ...(att.docId && { docId: att.docId })
      }))
    };

    return processedPayload;
  }

  // Get conversation head metadata for CAS preconditions
  getHead(conversation: number): { lastTurn: number; lastClosedSeq: number; hasOpenTurn: boolean } {
    // Get the last event in the conversation
    const lastEvent = this.db
      .prepare(`
        SELECT turn, seq, type, finality 
        FROM conversation_events 
        WHERE conversation = ?
        ORDER BY seq DESC 
        LIMIT 1
      `)
      .get(conversation) as { turn: number; seq: number; type: string; finality: string } | undefined;
    
    if (!lastEvent) {
      return { lastTurn: 0, lastClosedSeq: 0, hasOpenTurn: false };
    }
    
    // Get the last message with finality !== 'none'
    const lastClosedMessage = this.db
      .prepare(`
        SELECT seq 
        FROM conversation_events 
        WHERE conversation = ? AND type = 'message' AND finality != 'none'
        ORDER BY seq DESC 
        LIMIT 1
      `)
      .get(conversation) as { seq: number } | undefined;
    
    const lastClosedSeq = lastClosedMessage?.seq || 0;
    
    // Check if the current turn is open (no closing message on this turn)
    const hasOpenTurn = lastEvent.turn > 0 && !this.isTurnClosed(conversation, lastEvent.turn);
    
    return {
      lastTurn: lastEvent.turn,
      lastClosedSeq,
      hasOpenTurn
    };
  }

  // Mark a turn as closed (update lastClosedSeq)
  markTurnClosed(_conversation: number, _turn: number, _seq: number): void {
    // This is handled automatically when a message with finality is inserted
    // The getHead method will find it dynamically
    // No additional work needed here
  }
}