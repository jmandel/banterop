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

export type TurnRecoveryMode = 'resume' | 'restart' | ((snap: any) => 'resume' | 'restart');

export abstract class BaseAgent<TSnap = any> {
  private unsubscribe: (() => void) | undefined;
  private liveSnapshot: TSnap | undefined;
  private latestSeq = 0;
  protected running = false;  // Made protected so derived classes can check it
  private events: IAgentEvents | undefined;
  private inTurn = false;
  private lastProcessedClosedSeq = 0;
  
  protected turnRecoveryMode: TurnRecoveryMode = 'resume';

  constructor(
    protected transport: IAgentTransport,
    options?: { turnRecoveryMode?: TurnRecoveryMode }
  ) {
    if (options?.turnRecoveryMode) {
      this.turnRecoveryMode = options.turnRecoveryMode;
    }
  }

  async start(conversationId: number, agentId: string) {
    if (this.running) {
      logLine(agentId, 'warn', 'Agent already running');
      return;
    }
    
    this.running = true;
    logLine(agentId, 'start', `Starting agent for conversation ${conversationId}`);

    // Create event stream from transport
    logLine(agentId, 'debug', `Creating event stream for conversation ${conversationId} with guidance=true`);
    this.events = this.transport.createEventStream(conversationId, true);

    // Get live mirror initial state
    logLine(agentId, 'debug', `Getting initial snapshot for conversation ${conversationId}`);
    this.liveSnapshot = await this.transport.getSnapshot(conversationId, { includeScenario: true }) as TSnap;
    logLine(agentId, 'debug', `Initial snapshot has ${(this.liveSnapshot as any)?.events?.length || 0} events`);
    this.latestSeq = this.maxSeq(this.liveSnapshot);
    
    // Debug: Check if scenario is loaded for scenario-driven agents
    const snap = this.liveSnapshot as any;
    if (snap && !snap.scenario && snap.metadata?.scenarioId) {
      logLine(agentId, 'warn', `Snapshot missing scenario despite scenarioId: ${snap.metadata.scenarioId}`);
    }

    // Subscribe to events first
    logLine(agentId, 'debug', `Subscribing to events...`);
    this.unsubscribe = this.events.subscribe(async (ev) => {
      if (!this.running) return;
      
      // More detailed logging for guidance events
      if ((ev as any).type === 'guidance') {
        const g = ev as GuidanceEvent;
        logLine(agentId, 'debug', `Received GUIDANCE event: nextAgentId=${g.nextAgentId}, seq=${g.seq}, forUs=${g.nextAgentId === agentId}`);
      } else {
        logLine(agentId, 'debug', `Received event: ${JSON.stringify(ev).substring(0, 200)}`);
      }
      
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
        logLine(agentId, 'debug', `Received guidance for ${g.nextAgentId}, seq=${g.seq}`);
        
        if (g.nextAgentId !== agentId) {
          logLine(agentId, 'debug', `Guidance not for us (looking for ${agentId})`);
          return; // Not for us
        }
        
        logLine(agentId, 'guidance', `Received guidance seq=${g.seq}`);

        // If we're currently in a turn, ignore guidance (we're already working)
        if (this.inTurn) {
          logLine(agentId, 'debug', `Ignoring guidance - already in turn`);
          return;
        }

        // Reconcile and maybe act
        await this.reconcileAndMaybeAct(conversationId, agentId, g);
      }
    });
    
    // After subscribing, check if we should take action (reconcile without guidance)
    logLine(agentId, 'startup', 'Performing initial reconciliation');
    await this.reconcileAndMaybeAct(conversationId, agentId, null);
  }

  stop() {
    if (!this.running) return;
    
    this.running = false;  // Signal to interrupt any in-progress turn
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.events = undefined;
    this.liveSnapshot = undefined;
  }

  protected abstract takeTurn(ctx: TurnContext<TSnap>): Promise<void>;

  private async reconcileAndMaybeAct(conversationId: number, agentId: string, guidance: GuidanceEvent | null): Promise<void> {
    logLine(agentId, 'reconcile', `Starting reconcile (guidance seq: ${guidance?.seq || 'none'})`);
    
    // Fetch fresh snapshot
    logLine(agentId, 'reconcile', `Fetching snapshot for conversation ${conversationId}`);
    const snapshot = await this.transport.getSnapshot(conversationId, { includeScenario: true }) as TSnap;
    const snap = snapshot as any;
    logLine(agentId, 'reconcile', `Got snapshot with ${snap?.events?.length || 0} events, status: ${snap?.status}`);
    
    // Check if completed
    if (snap.status === 'completed') {
      logLine(agentId, 'reconcile', 'Conversation completed, stopping');
      this.stop();
      return;
    }

    // Check if lastClosedSeq has advanced (avoid duplicate work)
    const currentClosedSeq = snap.lastClosedSeq || 0;
    logLine(agentId, 'reconcile', `currentClosedSeq=${currentClosedSeq}, lastProcessedClosedSeq=${this.lastProcessedClosedSeq}`);
    if (guidance && this.lastProcessedClosedSeq > 0 && currentClosedSeq === this.lastProcessedClosedSeq) {
      logLine(agentId, 'reconcile', `No new closed turns since seq ${this.lastProcessedClosedSeq}, skipping`);
      return;
    }

    // Determine if there's an open turn and who owns it
    const hasOpenTurn = this.hasOpenTurn(snap);
    const lastEventAgent = this.getLastEventAgent(snap);
    const weOwnOpenTurn = hasOpenTurn && lastEventAgent === agentId;
    
    logLine(agentId, 'reconcile', `hasOpenTurn=${hasOpenTurn}, lastEventAgent=${lastEventAgent}, weOwn=${weOwnOpenTurn}`);

    if (hasOpenTurn && weOwnOpenTurn) {
      // We own the open turn - decide based on recovery mode
      const mode = typeof this.turnRecoveryMode === 'function' 
        ? this.turnRecoveryMode(snapshot)
        : this.turnRecoveryMode;
      
      logLine(agentId, 'reconcile', `We own open turn, recovery mode: ${mode}`);
      
      if (mode === 'restart') {
        // Abort the turn and start fresh
        const { turn } = await this.transport.clearTurn(conversationId, agentId);
        logLine(agentId, 'abort', `Aborted turn ${turn} per restart policy`);
        await this.startTurn(conversationId, agentId, guidance);
      } else {
        // Resume the open turn
        logLine(agentId, 'reconcile', `Resuming open turn`);
        await this.startTurn(conversationId, agentId, guidance);
      }
    } else if (hasOpenTurn && !weOwnOpenTurn) {
      // Someone else owns the open turn - do nothing
      logLine(agentId, 'reconcile', `Open turn owned by ${lastEventAgent}, waiting`);
    } else {
      // No open turn - check if it's our turn to start
      if (guidance && guidance.nextAgentId === agentId) {
        logLine(agentId, 'reconcile', `No open turn and guidance targets us, starting turn`);
        await this.startTurn(conversationId, agentId, guidance);
      } else {
        logLine(agentId, 'reconcile', `No open turn, no guidance for us`);
      }
    }

    // Update lastProcessedClosedSeq only if we took action
    if ((hasOpenTurn && weOwnOpenTurn) || (!hasOpenTurn && guidance && guidance.nextAgentId === agentId)) {
      logLine(agentId, 'reconcile', `Updating lastProcessedClosedSeq from ${this.lastProcessedClosedSeq} to ${currentClosedSeq}`);
      this.lastProcessedClosedSeq = currentClosedSeq;
    } else {
      logLine(agentId, 'reconcile', `Not updating lastProcessedClosedSeq (no action taken)`);
    }
  }

  private async startTurn(conversationId: number, agentId: string, guidance: GuidanceEvent | null): Promise<void> {
    logLine(agentId, 'startTurn', `Called with guidance seq: ${guidance?.seq || 'none'}, inTurn=${this.inTurn}`);
    if (this.inTurn) {
      logLine(agentId, 'warn', 'Already in turn, skipping start');
      return;
    }

    this.inTurn = true;
    try {
      // Create turn context
      const ctx: TurnContext<TSnap> = {
        conversationId,
        agentId,
        guidanceSeq: guidance?.seq || 0,
        deadlineMs: guidance?.deadlineMs || Date.now() + 30000,
        snapshot: this.clone(this.liveSnapshot!),
        transport: this.transport,
        getLatestSnapshot: () => this.clone(this.liveSnapshot!),
      };

      // Execute the turn
      logLine(agentId, 'turn', 'Starting turn execution');
      await this.takeTurn(ctx);
    } catch (error) {
      logLine(agentId, 'error', `Error in takeTurn: ${error}`);
    } finally {
      this.inTurn = false;
      logLine(agentId, 'turn', 'Turn execution completed');
    }
  }

  private hasOpenTurn(snapshot: any): boolean {
    if (!snapshot.events || snapshot.events.length === 0) {
      return false;
    }
    
    const lastEvent = snapshot.events[snapshot.events.length - 1];
    // System events (turn 0) don't count as open turns - they're metadata
    if (lastEvent.turn === 0 || lastEvent.type === 'system') {
      return false;
    }
    
    // Open turn = last event has finality 'none' or no finality
    // Since only messages can have turn/conversation finality, and traces/system must have 'none',
    // we only need to check the finality value
    return !lastEvent.finality || lastEvent.finality === 'none';
  }

  private getLastEventAgent(snapshot: any): string | null {
    if (!snapshot.events || snapshot.events.length === 0) {
      return null;
    }
    
    const lastEvent = snapshot.events[snapshot.events.length - 1];
    return lastEvent.agentId || null;
  }

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
      if (unifiedEvent.type === 'message' && unifiedEvent.finality !== 'none' && unifiedEvent.seq) {
        snap.lastClosedSeq = unifiedEvent.seq;
        logLine('snapshot', 'update', `Updated lastClosedSeq to ${unifiedEvent.seq}`);
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