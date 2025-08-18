import { Storage } from './storage';
import { SubscriptionBus } from './subscriptions';
import type { ConversationSnapshot, OrchestratorConfig, SchedulePolicy, GuidanceEvent, EventListener } from '$src/types/orchestrator.types';
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
import type { Conversation, CreateConversationParams, ListConversationsParams } from '$src/db/conversation.store';
import { StrictAlternationPolicy } from './strict-alternation-policy';
import { logLine } from '$src/lib/utils/logger';

export class OrchestratorService {
  public readonly storage: Storage;
  private bus: SubscriptionBus;
  private policy: SchedulePolicy;
  private isShuttingDown = false;
  private maxTurnsDefault: number;
  // Heartbeat removed; guidance is event-driven (on create and on turn completion)

  constructor(storage: Storage, bus?: SubscriptionBus, policy?: SchedulePolicy, _cfg?: OrchestratorConfig) {
    this.storage = storage;
    this.bus = bus ?? new SubscriptionBus();
    this.policy = policy ?? new StrictAlternationPolicy();
    this.maxTurnsDefault = _cfg?.maxTurnsDefault ?? 40;
    
    // Heartbeat disabled: guidance is event-driven (on create and on turn completion)
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    
    // No heartbeat timers to stop (event-driven only)

    // Clear subscriptions
    this.bus = new SubscriptionBus();
  }
  

  // Writes with fanout and post-write orchestration hooks
  appendEvent<T = unknown>(input: AppendEventInput<T>): AppendEventResult {
    if (this.isShuttingDown) {
      throw new Error('Orchestrator is shutting down');
    }
    
    // No precondition checking - rely on turn validation in sendMessage/sendTrace
    const res = this.storage.events.appendEvent(input);
    // Fanout the exact event we wrote (robust to ordering)
    const persisted = this.storage.events.getEventBySeq(res.conversation, res.seq);
    if (persisted) {
      this.bus.publish(persisted);
    }
    
    // If conversation finality set, mark conversation status
    if (input.type === 'message' && input.finality === 'conversation') {
      this.storage.conversations.complete(input.conversation);
    }
    
    // Post-write orchestration
    if (!this.isShuttingDown) {
      if (persisted) this.onEventAppended(persisted);
    }
    return res;
  }

  // Abort turn - adds marker and returns turn to use
  clearTurn(conversationId: number, agentId: string): { turn: number } {
    const head = this.storage.events.getHead(conversationId);
    
    // Check if there is an open turn and last event is by this agent
    if (head.hasOpenTurn) {
      const events = this.storage.events.getEvents(conversationId);
      const turnEvents = events.filter(e => e.turn === head.lastTurn);
      
      if (turnEvents.length > 0) {
        const lastEvent = turnEvents[turnEvents.length - 1];
        
        if (lastEvent && lastEvent.agentId === agentId) {
          // Check if last event is already an abort marker
          if (lastEvent && lastEvent.type === 'trace' && 
              lastEvent.payload && 
              typeof lastEvent.payload === 'object' && 
              'type' in lastEvent.payload &&
              lastEvent.payload.type === 'turn_cleared') {
            // Already aborted, don't write another
            return { turn: head.lastTurn };
          }
          
          // Append abort marker trace
          this.appendEvent({
            conversation: conversationId,
            turn: head.lastTurn,
            type: 'trace',
            payload: {
              type: 'turn_cleared',
              abortedBy: agentId,
              timestamp: new Date().toISOString(),
              reason: 'agent_restart'
            } as TracePayload,
            finality: 'none',
            agentId
          });
          
          return { turn: head.lastTurn };
        }
      }
    }
    
    // Turn closed or wrong agent - return next turn
    return { turn: head.lastTurn + 1 };
  }

  // Convenience helpers for common patterns

  sendTrace(conversation: number, turn: number, agentId: string, payload: TracePayload): AppendEventResult {
    const head = this.storage.events.getHead(conversation);
    
    // Validate the provided turn number
    if (head.hasOpenTurn && turn !== head.lastTurn) {
      throw new Error(`Turn already open (expected turn ${head.lastTurn}, got ${turn})`);
    }
    if (!head.hasOpenTurn && turn !== head.lastTurn + 1) {
      throw new Error(`Invalid turn number (expected ${head.lastTurn + 1}, got ${turn})`);
    }
    
    // Use the explicitly provided turn number
    const targetTurn = turn;
    
    return this.appendEvent({
      conversation,
      turn: targetTurn,  // ALWAYS provide turn number
      type: 'trace',
      payload,
      finality: 'none',
      agentId
    });
  }

  sendMessage(conversation: number, turn: number, agentId: string, payload: MessagePayload, finality: Finality): AppendEventResult {
    const head = this.storage.events.getHead(conversation);
    
    // Validate the provided turn number
    if (head.hasOpenTurn && turn !== head.lastTurn) {
      throw new Error(`Turn already open (expected turn ${head.lastTurn}, got ${turn})`);
    }
    if (!head.hasOpenTurn && turn !== head.lastTurn + 1) {
      throw new Error(`Invalid turn number (expected ${head.lastTurn + 1}, got ${turn})`);
    }
    
    // Use the explicitly provided turn number
    const targetTurn = turn;
    
    // If this is a terminal message, ensure outcome.status convention is set
    let payloadToWrite: MessagePayload = payload;
    if (finality === 'conversation') {
      try {
        const p: any = { ...(payload as any) };
        const outcome = p.outcome && typeof p.outcome === 'object' ? { ...p.outcome } : {};
        if (!outcome.status) outcome.status = 'completed';
        p.outcome = outcome;
        payloadToWrite = p as MessagePayload;
      } catch {
        // best-effort; ignore if shaping fails
      }
    }

    return this.appendEvent({
      conversation,
      turn: targetTurn,  // ALWAYS provide turn number
      type: 'message',
      payload: payloadToWrite,
      finality,
      agentId
    });
  }

  // Append a final message with finality='conversation' and a structured outcome.
  // This closes the conversation as a proper terminal message.
  async endConversation(
    conversationId: number,
    opts: {
      authorId?: string;
      text?: string;
      outcome?: 'completed' | 'canceled' | 'failed';
      metadata?: Record<string, any>;
    } = {}
  ): Promise<void> {
    const authorId = opts.authorId ?? 'system';
    const text = opts.text ?? 'Conversation ended.';
    let status: import('$src/types/event.types').MessagePayload['outcome'] = { status: 'completed' };
    if (opts.outcome === 'canceled') status = { status: 'canceled' };
    else if (opts.outcome === 'failed') status = { status: 'errored' };

    // Get the current state to determine the turn number
    const head = this.storage.events.getHead(conversationId);
    const closingTurn = head.hasOpenTurn ? head.lastTurn : head.lastTurn + 1;
    
    this.sendMessage(
      conversationId,
      closingTurn,
      authorId,
      { text, outcome: status, ...(opts.metadata ? { metadata: opts.metadata } : {}) } as any,
      'conversation'
    );
  }

  // Reads

  getConversationSnapshot(conversation: number, opts: { includeScenario?: boolean } = { includeScenario: true }): ConversationSnapshot {
    const events = this.storage.events.getEvents(conversation);
    const status = this.storage.events.getConversationStatus(conversation);
    const convoWithMeta = this.storage.conversations.getWithMetadata(conversation);
    const metadata = convoWithMeta?.metadata || { agents: [] };
    const head = this.storage.events.getHead(conversation);
    
    const snapshot: ConversationSnapshot = { 
      conversation, 
      status, 
      metadata, 
      events, 
      lastClosedSeq: head.lastClosedSeq 
    };

    // Include scenario if requested
    if (opts?.includeScenario) {
      if (metadata.scenarioId) {
        const scenarioItem = this.storage.scenarios.findScenarioById(metadata.scenarioId);
        snapshot.scenario = scenarioItem?.config || null;
      } else {
        snapshot.scenario = null;
      }
      snapshot.runtimeMeta = metadata;
    }

    return snapshot;
  }
  // Expose storage methods for conversations and attachments
  createConversation(params: CreateConversationParams): number {
    if (params.meta.scenarioId) {
      const scenarioItem = this.storage.scenarios.findScenarioById(params.meta.scenarioId);
      if (scenarioItem) {
        const scenarioIds = new Set(scenarioItem.config.agents.map(a => a.agentId));
        const runtimeIds = new Set(params.meta.agents.map(a => a.id));
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
      
      // Emit initial guidance if startingAgentId is specified
      if (convoWithMeta.metadata.startingAgentId) {
        logLine('orchestrator', 'info', 
          `Conversation ${conversationId} has startingAgentId: ${convoWithMeta.metadata.startingAgentId}`);
        
        const startingAgent = convoWithMeta.metadata.agents.find(
          a => a.id === convoWithMeta.metadata.startingAgentId
        );
        
        if (startingAgent) {
          const guidanceEvent: GuidanceEvent = {
            type: 'guidance',
            conversation: conversationId,
            seq: 0.1, // Initial guidance gets a fractional seq
            nextAgentId: startingAgent.id,
            kind: 'start_turn',
            deadlineMs: Date.now() + 30000,
            turn: 1, // First turn of the conversation
          };
          
          // Publish guidance immediately (event-driven only)
          this.bus.publishGuidance(guidanceEvent);
          
          logLine('orchestrator', 'guidance', 
            `Emitted initial guidance for ${startingAgent.id} on conversation ${conversationId}`);
        } else {
          logLine('orchestrator', 'warn', 
            `startingAgentId ${convoWithMeta.metadata.startingAgentId} not found in agents list`);
        }
      } else {
        logLine('orchestrator', 'info', 
          `Conversation ${conversationId} has no startingAgentId, no initial guidance emitted`);
      }
    }
    
    return conversationId;
  }

  getConversation(id: number): Conversation | null {
    return this.storage.conversations.get(id);
  }
  
  getConversationWithMetadata(id: number): Conversation | null {
    return this.storage.conversations.getWithMetadata(id);
  }

  listConversations(params: ListConversationsParams): Conversation[] {
    return this.storage.conversations.list(params);
  }

  getAttachment(id: string): AttachmentRow | null {
    return this.storage.attachments.getById(id);
  }

  listAttachmentsByConversation(conversationId: number): AttachmentRow[] {
    return this.storage.attachments.listByConversation(conversationId);
  }

  getAttachmentByDocId(conversationId: number, docId: string): AttachmentRow | null {
    return this.storage.attachments.getByDocId(conversationId, docId);
  }

  subscribe(conversation: number, listener: ((e: UnifiedEvent | GuidanceEvent) => void) | ((e: UnifiedEvent) => void), includeGuidance = false): string {
    const subId = this.bus.subscribe({ conversation }, listener as EventListener, includeGuidance);

    // If caller asked for guidance, emit a one-shot authoritative snapshot now
    if (includeGuidance) {
      try {
        const g = this.getGuidanceSnapshot(conversation);
        if (g) {
          (listener as (e: UnifiedEvent | GuidanceEvent) => void)(g);
        }
      } catch {
        // best-effort only
      }
    }

    return subId;
  }

  // New: filtered subscribe (types/agents)
  subscribeWithFilter(
    filter: { conversation: number; types?: Array<'message'|'trace'|'system'>; agents?: string[] },
    listener: ((e: UnifiedEvent | GuidanceEvent) => void),
    includeGuidance = false
  ): string {
    const subId = this.bus.subscribe(
      filter,
      listener as EventListener,
      includeGuidance
    );

    // Emit one-shot guidance snapshot immediately if requested
    if (includeGuidance && typeof filter.conversation === 'number' && filter.conversation >= 0) {
      try {
        const g = this.getGuidanceSnapshot(filter.conversation);
        if (g) {
          listener(g);
        }
      } catch {
        // best-effort only
      }
    }

    return subId;
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

  // Proactively emit guidance for a conversation, primarily to kick off a starting agent
  // when agents are (re)ensured after creation. This mirrors the initial-guidance path
  // in createConversation for the no‑messages case.
  pokeGuidance(conversationId: number): void {
    try {
      const convoWithMeta = this.getConversationSnapshot(conversationId, { includeScenario: true });
      if (!convoWithMeta) return;
      const hasMessages = (convoWithMeta.events || []).some(e => e.type === 'message');
      if (hasMessages) return;
      const starting = convoWithMeta.metadata.startingAgentId;
      if (!starting) return;
      const guidanceEvent: import('$src/types/orchestrator.types').GuidanceEvent = {
        type: 'guidance',
        conversation: conversationId,
        nextAgentId: starting,
        seq: 0.1,
        kind: 'start_turn',
        deadlineMs: Date.now() + 30000,
        turn: 1, // First turn for poke guidance
      };
      this.bus.publishGuidance(guidanceEvent);
    } catch {
      // best-effort
    }
  }

  // Internals

  /**
   * Compute the authoritative guidance snapshot for the given conversation
   * at this instant. Returns null if completed or no guidance is applicable.
   */
  getGuidanceSnapshot(conversationId: number): GuidanceEvent | null {
    const snap = this.getConversationSnapshot(conversationId, { includeScenario: true });
    if (!snap || snap.status === 'completed') return null;

    const events = snap.events || [];
    const messages = events.filter((e) => e.type === 'message');

    // No messages yet: if startingAgentId, kick off start_turn for turn 1
    if (messages.length === 0) {
      const startId = (snap.metadata as any)?.startingAgentId as string | undefined;
      if (startId) {
        return {
          type: 'guidance',
          conversation: conversationId,
          nextAgentId: startId,
          seq: 0.1,
          kind: 'start_turn',
          deadlineMs: Date.now() + 30000,
          turn: 1,
        };
      }
      return null;
    }

    // There are messages; look at the last one
    const lastMsg = messages[messages.length - 1]!;

    // If the last message closed a turn, ask policy who should start next
    if (lastMsg.finality === 'turn') {
      try {
        const decision = this.policy.decide({ snapshot: snap, lastEvent: lastMsg });
        if (decision.kind === 'agent' && decision.agentId) {
          return {
            type: 'guidance',
            conversation: conversationId,
            nextAgentId: decision.agentId,
            seq: (lastMsg.seq ?? 0) + 0.1,
            kind: 'start_turn',
            deadlineMs: Date.now() + 30000,
            turn: (lastMsg.turn ?? 0) + 1,
          };
        }
      } catch {
        // fall through
      }
      return null;
    }

    // Otherwise, the current turn is open; find the owner and emit continue_turn
    let owner: string | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (!ev) continue;
      if (ev.turn === lastMsg.turn && ev.type !== 'system') {
        owner = ev.agentId;
        break;
      }
    }
    if (owner) {
      return {
        type: 'guidance',
        conversation: conversationId,
        nextAgentId: owner,
        seq: (lastMsg.seq ?? 0) + 0.1,
        kind: 'continue_turn',
        deadlineMs: Date.now() + 30000,
        turn: lastMsg.turn,
      };
    }

    return null;
  }

  private onEventAppended(e: UnifiedEvent) {
    // Only react to message finality changes
    if (e.type === 'message' && (e.finality === 'turn' || e.finality === 'conversation')) {
      // Enforce max turns after a turn is closed
      if (e.finality === 'turn' && e.turn > 0) {
        try {
          const convo = this.storage.conversations.getWithMetadata(e.conversation);
          const meta = convo?.metadata as any;
          let maxTurns: number | undefined = undefined;
          const conf = meta?.config;
          if (conf && typeof conf === 'object' && conf.maxTurns !== undefined) {
            const v = Number(conf.maxTurns);
            if (Number.isFinite(v) && v > 0) maxTurns = Math.floor(v);
          }
          if (!maxTurns) maxTurns = this.maxTurnsDefault;
          if (maxTurns && e.turn >= maxTurns) {
            // Append a system-authored message to close the conversation
            this.appendEvent<import('$src/types/event.types').MessagePayload>({
              conversation: e.conversation,
              turn: e.turn, // Use the same turn that hit the limit
              type: 'message',
              payload: {
                text: `Auto-closed: reached maxTurns=${maxTurns}.`,
                outcome: { status: 'canceled', reason: 'max_turns' },
              },
              finality: 'conversation',
              agentId: 'system-orchestrator',
            });
            return; // no further scheduling once conversation is closed
          }
        } catch (err) {
          // Best-effort; don't derail normal flow if this fails
          console.error('[orchestrator] maxTurns enforcement error', err);
        }
      }
      // Get policy decision
      const decision = this.policy.decide({
        snapshot: this.getConversationSnapshot(e.conversation),
        lastEvent: e,
      });

      // Emit guidance events based on policy decision
      if (!this.isShuttingDown) {
        if (decision.kind === 'agent') {
          const nextAgentId = decision.agentId;
          
          if (nextAgentId) {
            const guidanceEvent: GuidanceEvent = {
              type: 'guidance',
              conversation: e.conversation,
              seq: e.seq + 0.1, // Fractional seq for ordering
              nextAgentId,
              kind: 'start_turn',
              deadlineMs: 30000,
              turn: e.turn + 1, // Next turn number after the one that just closed
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
      // System events always use turn 0
      const res = this.storage.events.appendEvent({
        conversation,
        turn: 0,
        type: 'system',
        payload: systemPayload,
        finality: 'none',
        agentId: 'system-orchestrator',
      });
      // Publish exactly what we wrote
      const persisted = this.storage.events.getEventBySeq(res.conversation, res.seq);
      if (persisted) this.bus.publish(persisted);
    } catch (err) {
      // System events are advisory, so we can silently skip on errors
      if (!this.isShuttingDown) {
        console.error('Failed to append system event', err);
      }
    }
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
        if (decision.kind === 'agent' && decision.agentId === agentId) {
          this.unsubscribe(subId);
          const deadlineMs = Date.now() + 30000;
          resolve({ deadlineMs });
          return;
        }
      }
    });
  }
}
