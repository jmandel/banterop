import type { IAgentTransport, IAgentEvents } from './runtime.interfaces';
import type { ConversationSnapshot, HydratedConversationSnapshot, GuidanceEvent } from '$src/types/orchestrator.types';
import type { StreamEvent } from '$src/agents/clients/event-stream';
import type { UnifiedEvent } from '$src/types/event.types';
import { logLine } from '$src/lib/utils/logger';

export interface TurnContext<TSnap = ConversationSnapshot> {
  conversationId: number;
  agentId: string;
  guidanceSeq: number;
  deadlineMs: number;
  snapshot: TSnap;
  transport: IAgentTransport;
  getLatestSnapshot: () => TSnap;
  lastClosedSeq: number; // Added to track the precondition
  currentTurn?: number; // Track if we're in an open turn
}

/**
 * Enhanced BaseAgent that automatically handles preconditions for CAS
 */
export abstract class BaseAgentWithPrecondition<TSnap extends ConversationSnapshot | HydratedConversationSnapshot = ConversationSnapshot> {
  protected liveSnapshot: TSnap | undefined;
  protected latestSeq: number = 0;
  protected unsubscribe: (() => void) | undefined;
  protected running: boolean = false;
  protected currentTurn: number | undefined; // Track the current open turn

  constructor(
    protected transport: IAgentTransport,
    protected events: IAgentEvents
  ) {}

  async start(conversationId: number, agentId: string): Promise<void> {
    if (this.running) {
      logLine(agentId, 'warning', 'Agent already running');
      return;
    }
    
    this.running = true;
    logLine(agentId, 'start', `Starting agent for conversation ${conversationId}`);

    // Get live mirror initial state
    this.liveSnapshot = await this.transport.getSnapshot(conversationId, { includeScenario: true }) as TSnap;
    this.latestSeq = this.maxSeq(this.liveSnapshot);

    // Subscribe to events
    this.unsubscribe = this.events.subscribe(async (ev) => {
      if (!this.running) return;
      
      // Apply event to live snapshot
      this.applyEvent(this.liveSnapshot, ev);

      // Check for conversation completion
      if (this.isConversationComplete(ev)) {
        logLine(agentId, 'complete', 'Conversation completed, stopping agent');
        this.stop();
        return;
      }

      // Handle guidance events
      if ((ev as GuidanceEvent).type === 'guidance') {
        const g = ev as GuidanceEvent;
        if (g.nextAgentId !== agentId) {
          return; // Not for us
        }
        
        logLine(agentId, 'guidance', `Received guidance seq=${g.seq}`);

        // Create enhanced turn context with precondition info
        const ctx: TurnContext<TSnap> = {
          conversationId,
          agentId,
          guidanceSeq: g.seq,
          deadlineMs: g.deadlineMs || Date.now() + 30000,
          snapshot: this.clone(this.liveSnapshot!),
          transport: this.createPreconditionAwareTransport(conversationId, agentId),
          getLatestSnapshot: () => this.clone(this.liveSnapshot!),
          lastClosedSeq: this.liveSnapshot!.lastClosedSeq,
          currentTurn: this.currentTurn
        };

        // Execute the turn
        try {
          await this.takeTurn(ctx);
          // After turn completes, reset current turn tracking
          this.currentTurn = undefined;
        } catch (error) {
          logLine(agentId, 'error', `Error in takeTurn: ${error}`);
        }
      }
    });
  }

  /**
   * Wrap the transport to automatically add preconditions
   */
  private createPreconditionAwareTransport(conversationId: number, agentId: string): IAgentTransport {
    const self = this;
    const originalTransport = this.transport;
    
    return {
      ...originalTransport,
      async postMessage(params: any) {
        // If this is the first message in our turn (no currentTurn set), 
        // we need to include the precondition
        if (self.currentTurn === undefined && !params.turn) {
          logLine(agentId, 'precondition', `Adding precondition lastClosedSeq=${self.liveSnapshot!.lastClosedSeq}`);
          params = {
            ...params,
            precondition: { lastClosedSeq: self.liveSnapshot!.lastClosedSeq }
          };
        }
        
        // Call the original transport
        const result = await originalTransport.postMessage(params);
        
        // Track the turn we're now in
        if (self.currentTurn === undefined) {
          self.currentTurn = result.turn;
          logLine(agentId, 'turn', `Now in turn ${self.currentTurn}`);
        }
        
        return result;
      },
      
      async postTrace(params: any) {
        // Same logic for traces
        if (self.currentTurn === undefined && !params.turn) {
          logLine(agentId, 'precondition', `Adding precondition to trace lastClosedSeq=${self.liveSnapshot!.lastClosedSeq}`);
          params = {
            ...params,
            precondition: { lastClosedSeq: self.liveSnapshot!.lastClosedSeq }
          };
        }
        
        const result = await originalTransport.postTrace(params);
        
        if (self.currentTurn === undefined) {
          self.currentTurn = result.turn;
          logLine(agentId, 'turn', `Now in turn ${self.currentTurn} (from trace)`);
        }
        
        return result;
      }
    };
  }

  stop() {
    if (!this.running) return;
    
    this.running = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.liveSnapshot = undefined;
    this.currentTurn = undefined;
  }

  protected abstract takeTurn(ctx: TurnContext<TSnap>): Promise<void>;

  private applyEvent(snap: any, ev: StreamEvent) {
    if (!snap) return;
    
    // Only apply unified events (not guidance)
    if ('type' in ev && ev.type !== 'guidance') {
      const unifiedEvent = ev as UnifiedEvent;
      snap.events = [...(snap.events ?? []), unifiedEvent];
      
      // Update conversation status if needed
      if (unifiedEvent.type === 'message' && unifiedEvent.finality === 'conversation') {
        snap.status = 'completed';
      }
      
      // Update latest sequence
      if (unifiedEvent.seq) {
        this.latestSeq = Math.max(this.latestSeq, unifiedEvent.seq);
      }
      
      // Update lastClosedSeq if this message closed a turn
      if (unifiedEvent.type === 'message' && unifiedEvent.finality !== 'none') {
        snap.lastClosedSeq = unifiedEvent.seq;
        logLine('agent', 'snapshot', `Updated lastClosedSeq to ${unifiedEvent.seq}`);
      }
    }
  }

  private isConversationComplete(ev: StreamEvent): boolean {
    if ('type' in ev && ev.type === 'message') {
      const msg = ev as UnifiedEvent;
      return msg.finality === 'conversation';
    }
    return false;
  }

  private clone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }

  private maxSeq(snap: any): number {
    if (!snap?.events?.length) return 0;
    return Math.max(...snap.events.map((e: any) => e.seq || 0));
  }
}