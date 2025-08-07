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
import { SimpleAlternationPolicy } from './policy';

export class OrchestratorService {
  public readonly storage: Storage;
  private bus: SubscriptionBus;
  private policy: SchedulePolicy;
  private cfg: OrchestratorConfig;
  private isShuttingDown = false;

  private watchdogInterval: Timer | undefined = undefined;

  constructor(storage: Storage, bus?: SubscriptionBus, policy?: SchedulePolicy, cfg?: OrchestratorConfig) {
    this.storage = storage;
    this.bus = bus ?? new SubscriptionBus();
    this.policy = policy ?? new SimpleAlternationPolicy();
    this.cfg = cfg ?? { idleTurnMs: 120_000 };
    
    // Start watchdog for expired claims
    this.startClaimWatchdog();
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    
    // Stop watchdog
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = undefined;
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
    const convoWithMeta = this.storage.conversations.getWithMetadata(conversation);
    const metadata = convoWithMeta?.metadata || { agents: [] };
    return { conversation, status, metadata, events };
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

    return {
      conversation: convo.conversation,
      status: convo.status as 'active' | 'completed',
      scenario,
      runtimeMeta: convo.metadata,
      events,
    };
  }

  // Expose storage methods for conversations and attachments
  createConversation(params: CreateConversationParams): number {
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

  unsubscribe(subId: string) {
    this.bus.unsubscribe(subId);
  }

  // Turn claim (Phase 2: actual implementation with SQLite)
  async claimTurn(conversationId: number, agentId: string, guidanceSeq: number): Promise<{ ok: boolean; reason?: string }> {
    // Check if conversation exists and is active
    const conv = this.storage.conversations.get(conversationId);
    if (!conv) {
      return { ok: false, reason: 'conversation not found' };
    }
    if (conv.status === 'completed') {
      return { ok: false, reason: 'conversation completed' };
    }

    // Calculate expiry using configured idle time
    const expiresAt = new Date(Date.now() + (this.cfg.idleTurnMs ?? 120_000)).toISOString();
    
    // Try to claim
    const claimed = this.storage.turnClaims.claim({
      conversation: conversationId,
      guidanceSeq,
      agentId,
      expiresAt,
    });
    
    if (claimed) {
      // Write system event to log the claim
      try {
        this.appendSystemEvent(conversationId, {
          kind: 'turn_claimed',
          data: { 
            agentId, 
            guidanceSeq, 
            expiresAt 
          },
        });
      } catch (err) {
        // System events are advisory, continue even if append fails
        console.error('Failed to append turn_claimed event:', err);
      }
      return { ok: true };
    } else {
      // Already claimed, check by whom
      const existing = this.storage.turnClaims.getClaim(conversationId, guidanceSeq);
      if (existing && existing.agentId === agentId) {
        // Same agent reclaiming, allow it (idempotent)
        return { ok: true };
      }
      return { ok: false, reason: 'already claimed' };
    }
  }

  // Internals

  private onEventAppended(e: UnifiedEvent) {
    // Clean up claims when a turn is completed by the claiming agent
    if (e.type === 'message' && e.finality === 'turn') {
      this.cleanupClaims(e.conversation);
    }
    
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


  // Watchdog for expired turn claims
  private startClaimWatchdog() {
    // Run every 5 seconds
    this.watchdogInterval = setInterval(() => {
      if (this.isShuttingDown) return;
      
      try {
        // Get expired claims before deleting them
        const expired = this.storage.turnClaims.getExpired();
        
        // Delete expired claims
        const deletedCount = this.storage.turnClaims.deleteExpired();
        
        if (deletedCount > 0) {
          // Emit system events for expired claims
          for (const claim of expired) {
            try {
              this.appendSystemEvent(claim.conversation, {
                kind: 'claim_expired',
                data: {
                  agentId: claim.agentId,
                  guidanceSeq: claim.guidanceSeq,
                  expiredAt: claim.expiresAt,
                },
              });
            } catch (err) {
              // System events are advisory, continue on error
              console.error('Failed to append claim_expired event:', err);
            }
          }
        }
      } catch (err) {
        console.error('Claim watchdog error:', err);
      }
    }, 5000);
  }
  
  // Clean up claims when a turn is successfully completed
  private cleanupClaims(conversation: number) {
    try {
      const activeClaims = this.storage.turnClaims.getActiveClaimsForConversation(conversation);
      for (const claim of activeClaims) {
        this.storage.turnClaims.deleteClaim(conversation, claim.guidanceSeq);
      }
    } catch (err) {
      // Non-critical cleanup, log and continue
      console.error('Failed to cleanup claims:', err);
    }
  }
}