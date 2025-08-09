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
  private guidanceHeartbeatTimer?: Timer;
  private lastGuidanceSeq = new Map<number, number>(); // Track last guidance seq per conversation
  private pendingGuidanceCheck: Promise<void> | null = null; // Track pending guidance check

  constructor(storage: Storage, bus?: SubscriptionBus, policy?: SchedulePolicy, _cfg?: OrchestratorConfig) {
    this.storage = storage;
    this.bus = bus ?? new SubscriptionBus();
    this.policy = policy ?? new StrictAlternationPolicy();
    
    // Start guidance heartbeat (every 2 seconds)
    this.startGuidanceHeartbeat();
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    
    // Stop guidance heartbeat immediately
    if (this.guidanceHeartbeatTimer) {
      clearInterval(this.guidanceHeartbeatTimer);
      this.guidanceHeartbeatTimer = undefined;
    }
    
    // Wait for any pending guidance check to complete
    if (this.pendingGuidanceCheck) {
      try {
        await this.pendingGuidanceCheck;
      } catch {
        // Ignore errors during shutdown
      }
    }
    
    // Clear subscriptions
    this.bus = new SubscriptionBus();
  }
  
  private startGuidanceHeartbeat(): void {
    // Clear any existing timer first
    if (this.guidanceHeartbeatTimer) {
      clearInterval(this.guidanceHeartbeatTimer);
    }
    
    this.guidanceHeartbeatTimer = setInterval(() => {
      if (this.isShuttingDown) return;
      
      // Track the pending operation
      this.pendingGuidanceCheck = this.checkAndBroadcastGuidance()
        .catch(error => {
          // Log error but don't crash
          if (!this.isShuttingDown) {
            console.error('[OrchestratorService] Error in guidance check:', error);
          }
        })
        .finally(() => {
          this.pendingGuidanceCheck = null;
        });
    }, 2000); // Check every 2 seconds
  }
  
  private async checkAndBroadcastGuidance(): Promise<void> {
    // Don't access database if shutting down
    if (this.isShuttingDown) return;
    
    try {
      // Get all active conversations
      const activeConversations = this.storage.conversations.list({ status: 'active' });
    
    for (const convo of activeConversations) {
      const events = this.storage.events.getEvents(convo.conversation);
      const metadata = convo.metadata;
      
      // Determine who should go next
      let nextAgentId: string | null = null;
      let guidanceSeq = 0.1; // Default for initial guidance
      
      // Check if conversation has started
      const messages = events.filter(e => e.type === 'message');
      
      if (messages.length === 0) {
        // No messages yet - use startingAgentId if available
        if (metadata?.startingAgentId) {
          nextAgentId = metadata.startingAgentId;
        }
      } else {
        // Has messages - use policy to determine next agent
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.finality === 'turn') {
          const snapshot = this.getConversationSnapshot(convo.conversation);
          const decision = this.policy.decide({ snapshot, lastEvent: lastMessage });
          
          if (decision.kind === 'agent') {
            nextAgentId = decision.agentId;
            guidanceSeq = lastMessage.seq + 0.1;
          }
        }
      }
      
      // If we have a next agent and haven't sent this guidance yet
      if (nextAgentId) {
        const lastSent = this.lastGuidanceSeq.get(convo.conversation) || 0;
        
        if (guidanceSeq > lastSent) {
          const agent = metadata?.agents?.find(a => a.id === nextAgentId);
          
          if (agent) {
            const guidanceEvent: GuidanceEvent = {
              type: 'guidance',
              conversation: convo.conversation,
              seq: guidanceSeq,
              nextAgentId,
              deadlineMs: Date.now() + 30000,
            };
            
            logLine('orchestrator', 'guidance-heartbeat', 
              `Broadcasting guidance for ${nextAgentId} in conversation ${convo.conversation} (seq ${guidanceSeq})`);
            
            this.bus.publishGuidance(guidanceEvent);
            this.lastGuidanceSeq.set(convo.conversation, guidanceSeq);
          }
        }
      }
    }
    } catch (error) {
      // Re-throw if not shutting down
      if (!this.isShuttingDown) {
        throw error;
      }
    }
  }

  // Writes with fanout and post-write orchestration hooks
  appendEvent<T = unknown>(input: AppendEventInput<T>): AppendEventResult {
    if (this.isShuttingDown) {
      throw new Error('Orchestrator is shutting down');
    }
    
    // No precondition checking - rely on turn validation in sendMessage/sendTrace
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

  // Abort turn - adds marker and returns turn to use
  abortTurn(conversationId: number, agentId: string): { turn: number } {
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
              lastEvent.payload.type === 'turn_aborted') {
            // Already aborted, don't write another
            return { turn: head.lastTurn };
          }
          
          // Append abort marker trace
          this.appendEvent({
            conversation: conversationId,
            turn: head.lastTurn,
            type: 'trace',
            payload: {
              type: 'turn_aborted',
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

  sendTrace(conversation: number, agentId: string, payload: TracePayload, turn?: number): AppendEventResult {
    const head = this.storage.events.getHead(conversation);
    
    // Validate explicit turn if provided
    if (turn !== undefined) {
      if (head.hasOpenTurn && turn !== head.lastTurn) {
        throw new Error(`Turn already open (expected turn ${head.lastTurn})`);
      }
      if (!head.hasOpenTurn && turn !== head.lastTurn + 1) {
        throw new Error(`Invalid turn number (next is ${head.lastTurn + 1})`);
      }
    }
    
    // Use provided turn, or continue open turn, or start new turn
    const targetTurn = turn ?? (head.hasOpenTurn ? head.lastTurn : undefined);
    
    return this.appendEvent({
      conversation,
      ...(targetTurn !== undefined ? { turn: targetTurn } : {}),
      type: 'trace',
      payload,
      finality: 'none',
      agentId
    });
  }

  sendMessage(conversation: number, agentId: string, payload: MessagePayload, finality: Finality, turn?: number): AppendEventResult {
    const head = this.storage.events.getHead(conversation);
    
    // Validate explicit turn if provided
    if (turn !== undefined) {
      if (head.hasOpenTurn && turn !== head.lastTurn) {
        throw new Error(`Turn already open (expected turn ${head.lastTurn})`);
      }
      if (!head.hasOpenTurn && turn !== head.lastTurn + 1) {
        throw new Error(`Invalid turn number (next is ${head.lastTurn + 1})`);
      }
    }
    
    // Use provided turn, or continue open turn, or start new turn
    const targetTurn = turn ?? (head.hasOpenTurn ? head.lastTurn : undefined);
    
    return this.appendEvent({
      conversation,
      ...(targetTurn !== undefined ? { turn: targetTurn } : {}),
      type: 'message',
      payload,
      finality,
      agentId
    });
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
            deadlineMs: Date.now() + 30000,
          };
          
          // Publish guidance immediately
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

  subscribe(conversation: number, listener: ((e: UnifiedEvent | GuidanceEvent) => void) | ((e: UnifiedEvent) => void), includeGuidance = false): string {
    const subId = this.bus.subscribe({ conversation }, listener as EventListener, includeGuidance);
    
    // The guidance heartbeat will handle sending guidance at regular intervals
    // No need for special initial guidance logic here
    
    return subId;
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
        if (decision.kind === 'agent') {
          const nextAgentId = decision.agentId;
          
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