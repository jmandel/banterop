import { Storage } from './storage';
import { SubscriptionBus } from './subscriptions';
import type { ConversationSnapshot, HydratedConversationSnapshot, OrchestratorConfig, SchedulePolicy, GuidanceEvent, EventListener } from '$src/types/orchestrator.types';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
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
import type { ConversationRow, ConversationWithMeta, CreateConversationParams, ListConversationsParams } from '$src/db/conversation.store';
import { StrictAlternationPolicy } from './strict-alternation-policy';

export class OrchestratorService {
  public readonly storage: Storage;
  private bus: SubscriptionBus;
  private policy: SchedulePolicy;
  private isShuttingDown = false;

  constructor(storage: Storage, bus?: SubscriptionBus, policy?: SchedulePolicy, _cfg?: OrchestratorConfig) {
    this.storage = storage;
    this.bus = bus ?? new SubscriptionBus();
    this.policy = policy ?? new StrictAlternationPolicy();
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    
    // Clear subscriptions
    this.bus = new SubscriptionBus();
  }

  // Writes with fanout and post-write orchestration hooks (with CAS support)
  appendEvent<T = unknown>(input: AppendEventInput<T> & { precondition?: { lastClosedSeq: number } }): AppendEventResult {
    if (this.isShuttingDown) {
      throw new Error('Orchestrator is shutting down');
    }
    
    // Get conversation head for CAS checking
    const head = this.storage.events.getHead(input.conversation);
    
    const openingNewTurn = input.turn == null; // caller didn't specify a turn
    if (openingNewTurn) {
      // Check precondition for opening a new turn
      // Initial turn can omit precondition (treated as 0)
      const requiredSeq = head.lastClosedSeq;
      const providedSeq = input.precondition?.lastClosedSeq ?? 0;
      
      // For the very first turn (no events yet), allow missing precondition
      const isFirstTurn = head.lastTurn === 0;
      if (!isFirstTurn && providedSeq !== requiredSeq) {
        throw new Error(`Precondition failed: expected lastClosedSeq=${requiredSeq}, got ${providedSeq}`);
      }
      
      // Allocate new turn number
      const newTurn = head.lastTurn + 1;
      input.turn = newTurn;
      
      // If first event is a trace, emit a system turn_started event
      if (input.type === 'trace') {
        // First append the turn_started system event
        this.storage.events.appendEvent({
          conversation: input.conversation,
          turn: newTurn,
          type: 'system',
          payload: { 
            kind: 'turn_started', 
            data: { 
              turn: newTurn, 
              phase: 'work', 
              opener: input.agentId 
            } 
          },
          finality: 'none',
          agentId: 'system-orchestrator'
        });
      }
    } else {
      // Appending to an existing turn: check if it's closed
      if (this.storage.events.isTurnClosed(input.conversation, input.turn!)) {
        throw new Error(`Cannot append to closed turn ${input.turn}`);
      }
    }
    
    const res = this.storage.events.appendEvent(input);
    // Fanout the exact event we wrote (robust to ordering)
    const persisted = this.storage.events.getEventBySeq(res.seq);
    if (persisted) {
      this.bus.publish(persisted);
    }
    
    // If conversation finality set, mark conversation status and clear autoRun flag
    if (input.type === 'message' && input.finality === 'conversation') {
      this.storage.conversations.complete(input.conversation);
      
      // Clear autoRun flag if set
      const convo = this.storage.conversations.getWithMetadata(input.conversation);
      if (convo?.metadata?.custom?.autoRun) {
        convo.metadata.custom.autoRun = false;
        this.storage.conversations.updateMeta(convo.conversation, convo.metadata);
        console.log(`[AutoRun] Conversation ${convo.conversation} completed; autoRun flag cleared.`);
      }
    }
    
    // Post-write orchestration
    if (!this.isShuttingDown) {
      if (persisted) this.onEventAppended(persisted);
    }
    return res;
  }

  // Convenience helpers for common patterns

  sendTrace(conversation: number, agentId: string, payload: TracePayload, turn?: number, precondition?: { lastClosedSeq: number }): AppendEventResult {
    // Determine turn: use provided or try to find an open turn
    // If no open turn exists, traces can now start a new turn
    const targetTurn = turn ?? this.tryFindOpenTurn(conversation);
    // Pass undefined turn to appendEvent to allow trace-started turn
    return this.appendEvent({
      conversation,
      ...(targetTurn !== undefined ? { turn: targetTurn } : {}),
      type: 'trace',
      payload,
      finality: 'none',
      agentId,
      ...(precondition !== undefined ? { precondition } : {}),
    });
  }

  sendMessage(conversation: number, agentId: string, payload: MessagePayload, finality: Finality, turn?: number, precondition?: { lastClosedSeq: number }): AppendEventResult {
    // If turn is omitted, this starts a new turn (allowed for message)
    const input: AppendEventInput<MessagePayload> & { precondition?: { lastClosedSeq: number } } = {
      conversation,
      type: 'message',
      payload,
      finality,
      agentId,
    };
    if (turn !== undefined) {
      input.turn = turn;
    }
    if (precondition !== undefined) {
      input.precondition = precondition;
    }
    return this.appendEvent(input);
  }

  // Reads

  getConversationSnapshot(conversation: number): ConversationSnapshot {
    const events = this.storage.events.getEvents(conversation);
    const status = this.storage.events.getConversationStatus(conversation);
    const convoWithMeta = this.storage.conversations.getWithMetadata(conversation);
    const metadata = convoWithMeta?.metadata || { agents: [] };
    const head = this.storage.events.getHead(conversation);
    return { conversation, status, metadata, events, lastClosedSeq: head.lastClosedSeq };
  }

  getHydratedConversationSnapshot(conversationId: number): HydratedConversationSnapshot | null {
    const convo = this.storage.conversations.getWithMetadata(conversationId);
    if (!convo) return null;

    const events = this.storage.events.getEvents(conversationId);
    let scenario: ScenarioConfiguration | null = null;
    if (convo.scenarioId) {
      const scenarioItem = this.storage.scenarios.findScenarioById(convo.scenarioId);
      scenario = scenarioItem?.config || null;
    }
    
    const head = this.storage.events.getHead(conversationId);

    return {
      conversation: convo.conversation,
      status: convo.status as 'active' | 'completed',
      scenario,
      runtimeMeta: convo.metadata,
      events,
      lastClosedSeq: head.lastClosedSeq,
    };
  }

  // Expose storage methods for conversations and attachments
  createConversation(params: CreateConversationParams): number {
    if (params.scenarioId) {
      const scenarioItem = this.storage.scenarios.findScenarioById(params.scenarioId);
      if (scenarioItem) {
        const scenarioIds = new Set(scenarioItem.config.agents.map(a => a.agentId));
        const runtimeIds = new Set((params.agents || []).map(a => a.id));
        if (
          scenarioIds.size !== runtimeIds.size ||
          [...scenarioIds].some(id => !runtimeIds.has(id))
        ) {
          throw new Error(
            `Config error: runtime agents must match scenario agents exactly.\n` +
            `Scenario agents: ${[...scenarioIds].join(', ')}\n` +
            `Runtime agents: ${[...runtimeIds].join(', ')}`
          );
        }
      }
    }

    const conversationId = this.storage.conversations.create(params);
    
    // Emit meta_created system event
    const convoWithMeta = this.storage.conversations.getWithMetadata(conversationId);
    if (convoWithMeta) {
      this.appendSystemEvent(conversationId, {
        kind: 'meta_created',
        metadata: convoWithMeta.metadata,
      });
    }
    
    return conversationId;
  }

  getConversation(id: number): ConversationRow | null {
    return this.storage.conversations.get(id);
  }
  
  getConversationWithMetadata(id: number): ConversationWithMeta | null {
    return this.storage.conversations.getWithMetadata(id);
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

  subscribe(conversation: number, listener: ((e: UnifiedEvent | GuidanceEvent) => void) | ((e: UnifiedEvent) => void), includeGuidance = false): string {
    return this.bus.subscribe({ conversation }, listener as EventListener, includeGuidance);
  }

  // New: filtered subscribe (types/agents)
  subscribeWithFilter(
    filter: { conversation: number; types?: Array<'message'|'trace'|'system'>; agents?: string[] },
    listener: ((e: UnifiedEvent | GuidanceEvent) => void),
    includeGuidance = false
  ): string {
    return this.bus.subscribe(
      filter,
      listener as EventListener,
      includeGuidance
    );
  }

  // Optional: subscribe to all conversations (wildcard)
  subscribeAll(listener: ((e: UnifiedEvent | GuidanceEvent) => void), includeGuidance = false): string {
    return this.bus.subscribe({ conversation: -1 }, listener as EventListener, includeGuidance);
  }

  getEventsSince(conversation: number, sinceSeq?: number): UnifiedEvent[] {
    return this.storage.events.getEventsSince(conversation, sinceSeq);
  }

  getEventsPage(conversationId: number, afterSeq?: number, limit?: number): UnifiedEvent[] {
    return this.storage.events.getEventsPage(conversationId, afterSeq, limit);
  }

  unsubscribe(subId: string) {
    this.bus.unsubscribe(subId);
  }

  // Internals

  private onEventAppended(e: UnifiedEvent) {
    // Only react to message finality changes
    if (e.type === 'message' && (e.finality === 'turn' || e.finality === 'conversation')) {
      // Get policy decision
      const decision = this.policy.decide({
        snapshot: this.getConversationSnapshot(e.conversation),
        lastEvent: e,
      });

      // Emit guidance events based on policy decision
      if (!this.isShuttingDown) {
        if (decision.kind === 'internal' || decision.kind === 'external') {
          const nextAgentId = decision.kind === 'internal' 
            ? decision.agentId 
            : decision.candidates[0]; // For external, use first candidate as hint
          
          if (nextAgentId) {
            const guidanceEvent: GuidanceEvent = {
              type: 'guidance',
              conversation: e.conversation,
              seq: e.seq + 0.1, // Fractional seq for ordering
              nextAgentId,
              deadlineMs: 30000,
            };
            this.bus.publishGuidance(guidanceEvent);
          }
        }
      }
    }
  }

  /// NOTE: All system events are stored in turn 0 as an out-of-band "meta lane"
  /// regardless of the current open turn. This allows orchestration/meta signals
  /// (e.g., meta_created) to exist in parallel to regular turn 1..N
  /// streams and be replayed independently.
  private appendSystemEvent(conversation: number, systemPayload: SystemPayload) {
    if (this.isShuttingDown) return;
    
    try {
      // With EventStore routing, no turn is required; system events will go to turn 0
      const res = this.storage.events.appendEvent({
        conversation,
        type: 'system',
        payload: systemPayload,
        finality: 'none',
        agentId: 'system-orchestrator',
      });
      // Publish exactly what we wrote
      const persisted = this.storage.events.getEventBySeq(res.seq);
      if (persisted) this.bus.publish(persisted);
    } catch (err) {
      // System events are advisory, so we can silently skip on errors
      if (!this.isShuttingDown) {
        console.error('Failed to append system event', err);
      }
    }
  }

  private tryFindOpenTurn(conversation: number): number | undefined {
    // Non-throwing helper to find an open turn, or return undefined if none exists
    const events = this.storage.events.getEvents(conversation);
    if (events.length === 0) return undefined;
    const lastEvent = events[events.length - 1];
    if (!lastEvent) return undefined;
    const currentTurn = lastEvent.turn;
    // Check if the last message finalized the turn; if yes, no open turn
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e) continue;
      if (e.turn !== currentTurn) break;
      if (e.type === 'message' && e.finality !== 'none') {
        return undefined; // Turn is closed
      }
    }
    return currentTurn;
  }

  // Wait for this agent's turn - used by internal executors
  async waitForTurn(conversationId: number, agentId: string): Promise<{ deadlineMs: number } | null> {
    return new Promise((resolve) => {
      // Subscribe with guidance to get scheduling decisions
      const subId = this.subscribe(
        conversationId,
        (event: any) => {
          // Check for conversation completion
          if ('type' in event && event.type === 'message') {
            const msg = event as UnifiedEvent;
            if (msg.finality === 'conversation') {
              this.unsubscribe(subId);
              resolve(null);
              return;
            }
          }

          // Check if we got a guidance event for this agent
          if ('type' in event && event.type === 'guidance') {
            const guidance = event as GuidanceEvent;
            if (guidance.nextAgentId === agentId) {
              this.unsubscribe(subId);
              const deadlineMs = guidance.deadlineMs || (Date.now() + 30000);
              resolve({ deadlineMs });
              return;
            }
          }
        },
        true // includeGuidance
      );

      // Also check current state immediately
      const snapshot = this.getConversationSnapshot(conversationId);
      if (snapshot.status === 'completed') {
        this.unsubscribe(subId);
        resolve(null);
        return;
      }

      // Check if there's already a decision for this agent based on last event
      const lastEvent = snapshot.events[snapshot.events.length - 1];
      if (lastEvent) {
        const decision = this.policy.decide({ snapshot, lastEvent });
        if (decision.kind === 'internal' && decision.agentId === agentId) {
          this.unsubscribe(subId);
          const deadlineMs = Date.now() + 30000;
          resolve({ deadlineMs });
          return;
        }
      }
    });
  }
}