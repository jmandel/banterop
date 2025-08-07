import { Storage } from './storage';
import { SubscriptionBus } from './subscriptions';
import type { ConversationSnapshot, OrchestratorConfig, SchedulePolicy } from '$src/types/orchestrator.types';
import type {
  AppendEventInput,
  AppendEventResult,
  UnifiedEvent,
  Finality,
  MessagePayload,
  TracePayload,
  SystemPayload,
  AttachmentRow,
} from '$src/types/event.types';
import type { ConversationRow, CreateConversationParams, ListConversationsParams } from '$src/db/conversation.store';
import { SimpleAlternationPolicy } from './policy';

export class OrchestratorService {
  private storage: Storage;
  private bus: SubscriptionBus;
  private policy: SchedulePolicy;
  private cfg: OrchestratorConfig;
  private isShuttingDown = false;

  // In-memory guard for "in-flight" internal work per conversation to avoid duplicate workers.
  private inflightInternal = new Map<number, Promise<void>>();

  constructor(storage: Storage, bus?: SubscriptionBus, policy?: SchedulePolicy, cfg?: OrchestratorConfig) {
    this.storage = storage;
    this.bus = bus ?? new SubscriptionBus();
    this.policy = policy ?? new SimpleAlternationPolicy();
    this.cfg = cfg ?? { idleTurnMs: 120_000, emitNextCandidates: true };
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    
    // Wait for all in-flight workers to complete
    const workers = Array.from(this.inflightInternal.values());
    if (workers.length > 0) {
      await Promise.allSettled(workers);
    }
    
    // Clear subscriptions
    this.bus = new SubscriptionBus();
  }

  // Writes with fanout and post-write orchestration hooks
  appendEvent<T = unknown>(input: AppendEventInput<T>): AppendEventResult {
    if (this.isShuttingDown) {
      throw new Error('Orchestrator is shutting down');
    }
    
    const res = this.storage.events.appendEvent(input);
    const last = this.getLastEvent(res.conversation)!;
    // Fanout
    this.bus.publish(last);
    // Post-write orchestration
    if (!this.isShuttingDown) {
      this.onEventAppended(last);
    }
    return res;
  }

  // Convenience helpers for common patterns

  sendTrace(conversation: number, agentId: string, payload: TracePayload, turn?: number): void {
    // Determine turn: use provided or the last open turn authored by this agent, else error
    const targetTurn = turn ?? this.findOpenTurn(conversation);
    this.appendEvent({
      conversation,
      turn: targetTurn,
      type: 'trace',
      payload,
      finality: 'none',
      agentId,
    });
  }

  sendMessage(conversation: number, agentId: string, payload: MessagePayload, finality: Finality, turn?: number): void {
    // If turn is omitted, this starts a new turn (allowed for message)
    const input: AppendEventInput<MessagePayload> = {
      conversation,
      type: 'message',
      payload,
      finality,
      agentId,
    };
    if (turn !== undefined) {
      input.turn = turn;
    }
    this.appendEvent(input);
  }

  // Reads

  getConversationSnapshot(conversation: number): ConversationSnapshot {
    const events = this.storage.events.getEvents(conversation);
    const status = this.storage.events.getConversationStatus(conversation);
    return { conversation, status, events };
  }

  // Expose storage methods for conversations and attachments
  createConversation(params: CreateConversationParams): number {
    return this.storage.conversations.create(params);
  }

  getConversation(id: number): ConversationRow | null {
    return this.storage.conversations.get(id);
  }

  listConversations(params: ListConversationsParams): ConversationRow[] {
    return this.storage.conversations.list(params);
  }

  getAttachment(id: string): AttachmentRow | null {
    return this.storage.attachments.getById(id);
  }

  listAttachmentsByConversation(conversationId: number): AttachmentRow[] {
    return this.storage.attachments.listByConversation(conversationId);
  }

  subscribe(conversation: number, listener: (e: UnifiedEvent) => void): string {
    return this.bus.subscribe({ conversation }, listener);
  }

  unsubscribe(subId: string) {
    this.bus.unsubscribe(subId);
  }

  // Internals

  private onEventAppended(e: UnifiedEvent) {
    // Only react to message finality changes
    if (e.type === 'message' && (e.finality === 'turn' || e.finality === 'conversation')) {
      // Optionally emit advisory next-candidate system event
      if (this.cfg.emitNextCandidates) {
        const decision = this.policy.decide({
          snapshot: this.getConversationSnapshot(e.conversation),
          lastEvent: e,
        });

        if (decision.kind === 'external') {
          this.appendSystemEvent(e.conversation, {
            kind: 'next_candidate_agents',
            data: { candidates: decision.candidates, note: decision.note },
          });
        }

        if (decision.kind === 'internal' && !this.isShuttingDown) {
          this.spawnInternalWorker(e.conversation, decision.agentId);
        }
      }
    }
  }

  private appendSystemEvent(conversation: number, systemPayload: SystemPayload) {
    if (this.isShuttingDown) return;
    
    // System events cannot finalize anything
    // System events should create a new turn if the previous one is finalized
    try {
      const snapshot = this.getConversationSnapshot(conversation);
      let turn: number | undefined;
      
      // Check if we need a new turn (if last message finalized)
      if (snapshot.events.length > 0) {
        const lastEvent = snapshot.events[snapshot.events.length - 1]!;
        if (lastEvent.type === 'message' && lastEvent.finality !== 'none') {
          // Previous turn is closed, don't provide turn to start a new one
          turn = undefined;
        } else {
          // Use current turn
          turn = lastEvent.turn;
        }
      }
      
      // For system events that can't start a turn, we need to start with a message
      if (!turn) {
        // System events can't start turns, so skip if no open turn
        return;
      }
      
      this.storage.events.appendEvent({
        conversation,
        turn,
        type: 'system',
        payload: systemPayload,
        finality: 'none',
        agentId: 'system-orchestrator',
      });
      // Publish the last event for this conversation (the system event we just appended)
      const last = this.getLastEvent(conversation);
      if (last) this.bus.publish(last);
    } catch (err) {
      // System events are advisory, so we can silently skip on errors
      if (!this.isShuttingDown) {
        console.error('Failed to append system event', err);
      }
    }
  }

  private getLastEvent(conversation: number): UnifiedEvent | undefined {
    const snapshot = this.getConversationSnapshot(conversation);
    return snapshot.events[snapshot.events.length - 1];
  }

  private findOpenTurn(conversation: number): number {
    // An "open turn" is defined as a turn that has no message with finality != 'none' yet.
    // We can compute by scanning from end.
    const events = this.storage.events.getEvents(conversation);
    if (events.length === 0) throw new Error('No turns exist');
    const lastEvent = events[events.length - 1];
    if (!lastEvent) throw new Error('No events exist');
    const currentTurn = lastEvent.turn;
    // Check if the last message finalized the turn; if yes, no open turn
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e) continue;
      if (e.turn !== currentTurn) break;
      if (e.type === 'message' && e.finality !== 'none') {
        throw new Error('No open turn for traces; provide turn explicitly');
      }
    }
    return currentTurn;
  }

  private spawnInternalWorker(conversation: number, agentId: string) {
    if (this.inflightInternal.has(conversation) || this.isShuttingDown) return;
    
    const workerPromise = (async () => {
      try {
        // Check if shutting down before starting work
        if (this.isShuttingDown) return;
        
        // Lazy import to avoid cycles
        const { WorkerRunner } = await import('./worker-runner');
        const runner = new WorkerRunner(this);
        await runner.runOneTurn(conversation, agentId);
      } catch (err) {
        if (!this.isShuttingDown) {
          console.error('Internal worker failed', { conversation, agentId, err });
          // Optionally append a system note
          this.appendSystemEvent(conversation, { kind: 'note', data: { error: String(err) } });
        }
      } finally {
        this.inflightInternal.delete(conversation);
      }
    })();
    
    this.inflightInternal.set(conversation, workerPromise);
  }
  
  // Test helper to wait for workers
  async waitForWorkers(conversation: number): Promise<void> {
    const workerPromise = this.inflightInternal.get(conversation);
    if (workerPromise) {
      await workerPromise;
    }
  }
}