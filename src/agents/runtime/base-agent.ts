import type { IAgentTransport, IAgentEvents } from './runtime.interfaces';
import type { StreamEvent } from '$src/agents/clients/event-stream';
import type { GuidanceEvent } from '$src/types/orchestrator.types';
import type { UnifiedEvent } from '$src/types/event.types';
import { logLine } from '$src/lib/utils/logger';

export interface TurnContext<TSnap = any> {
  conversationId: number;
  agentId: string;
  guidanceSeq: number;
  deadlineMs: number;
  snapshot: TSnap; // stable at turn start
  transport: IAgentTransport;
  getLatestSnapshot(): TSnap; // live mirror
}

export abstract class BaseAgent<TSnap = any> {
  private unsubscribe: (() => void) | undefined;
  private liveSnapshot: TSnap | undefined;
  private latestSeq = 0;
  private running = false;

  constructor(
    protected transport: IAgentTransport,
    protected events: IAgentEvents
  ) {}

  async start(conversationId: number, agentId: string) {
    if (this.running) {
      logLine(agentId, 'warn', 'Agent already running');
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

        // Create turn context (no claiming needed with CAS preconditions)
        const ctx: TurnContext<TSnap> = {
          conversationId,
          agentId,
          guidanceSeq: g.seq,
          deadlineMs: g.deadlineMs || Date.now() + 30000,
          snapshot: this.clone(this.liveSnapshot!),
          transport: this.transport,
          getLatestSnapshot: () => this.clone(this.liveSnapshot!),
        };

        // Execute the turn
        try {
          await this.takeTurn(ctx);
        } catch (error) {
          logLine(agentId, 'error', `Error in takeTurn: ${error}`);
        }
      }
    });
  }

  stop() {
    if (!this.running) return;
    
    this.running = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.liveSnapshot = undefined;
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