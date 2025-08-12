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

    // Compute current turn state (open/owner) for safe recovery
    const { hasOpenTurn, ownerAgentId } = this.getCurrentTurnState(snap);
    logLine(agentId, 'reconcile', `hasOpenTurn=${hasOpenTurn}, owner=${ownerAgentId}`);

    // Startup reconciliation: if no guidance but we own an open turn, act per recovery policy
    if (!guidance) {
      if (hasOpenTurn && ownerAgentId === agentId) {
        const mode = typeof this.turnRecoveryMode === 'function' ? this.turnRecoveryMode(snapshot) : this.turnRecoveryMode;
        if (mode === 'restart') {
          const { turn } = await this.transport.clearTurn(conversationId, agentId);
          logLine(agentId, 'abort', `Aborted turn ${turn} per restart policy (startup)`);
        }
        await this.startTurn(conversationId, agentId, null);
      } else {
        logLine(agentId, 'reconcile', 'No guidance and not owning open turn; idle');
      }
      return;
    }

    // Default guidance.kind if absent (back-compat)
    const effectiveKind: GuidanceEvent['kind'] = (guidance as any).kind ?? (hasOpenTurn ? 'continue_turn' : 'start_turn');

    // Guard against duplicate guidance when lastClosedSeq hasn't advanced
    const currentClosed = (snap?.lastClosedSeq ?? 0) as number;
    if (this.lastProcessedClosedSeq !== 0 && currentClosed === this.lastProcessedClosedSeq) {
      logLine(agentId, 'reconcile', `Ignoring guidance (lastClosedSeq unchanged at ${currentClosed})`);
      return;
    }

    if (effectiveKind === 'continue_turn') {
      if (hasOpenTurn && ownerAgentId === agentId) {
        const mode = typeof this.turnRecoveryMode === 'function' ? this.turnRecoveryMode(snapshot) : this.turnRecoveryMode;
        if (mode === 'restart') {
          const { turn } = await this.transport.clearTurn(conversationId, agentId);
          logLine(agentId, 'abort', `Aborted turn ${turn} per restart policy`);
        }
        this.lastProcessedClosedSeq = currentClosed;
        await this.startTurn(conversationId, agentId, guidance);
      } else if (hasOpenTurn && ownerAgentId && ownerAgentId !== agentId) {
        logLine(agentId, 'reconcile', `Guided to continue but open turn owned by ${ownerAgentId}; waiting`);
      } else {
        // No open turn visible (post-reboot) — start fresh per guidance
        this.lastProcessedClosedSeq = currentClosed;
        await this.startTurn(conversationId, agentId, guidance);
      }
      return;
    }

    if (effectiveKind === 'start_turn') {
      if (hasOpenTurn) {
        if (ownerAgentId === agentId) {
          const { turn } = await this.transport.clearTurn(conversationId, agentId);
          logLine(agentId, 'abort', `Cleared open turn ${turn} before starting next`);
          this.lastProcessedClosedSeq = currentClosed;
          await this.startTurn(conversationId, agentId, guidance);
        } else {
          logLine(agentId, 'reconcile', `Open turn owned by ${ownerAgentId}; waiting`);
        }
      } else {
        this.lastProcessedClosedSeq = currentClosed;
        await this.startTurn(conversationId, agentId, guidance);
      }
      return;
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

  private getCurrentTurnState(snapshot: any): { hasOpenTurn: boolean; ownerAgentId: string | null } {
    if (!snapshot?.events?.length) return { hasOpenTurn: false, ownerAgentId: null };
    // Highest non-system turn
    let currentTurn = 0;
    for (const e of snapshot.events) {
      if (e.type !== 'system' && e.turn > currentTurn) currentTurn = e.turn;
    }
    if (currentTurn === 0) {
      // Fallback: some tests/snapshots omit 'turn'; infer from last event
      const last = snapshot.events[snapshot.events.length - 1];
      if (last && last.type === 'message' && last.finality && last.finality !== 'none') {
        return { hasOpenTurn: false, ownerAgentId: null };
      }
      if (last && last.type !== 'system') {
        return { hasOpenTurn: true, ownerAgentId: last.agentId || null };
      }
      return { hasOpenTurn: false, ownerAgentId: null };
    }
    // Closed if any message in currentTurn has finality != 'none'
    let closed = false;
    for (const e of snapshot.events) {
      if (e.turn !== currentTurn) continue;
      if (e.type === 'message' && e.finality && e.finality !== 'none') { closed = true; break; }
    }
    if (closed) return { hasOpenTurn: false, ownerAgentId: null };
    // Owner = last non-system event in currentTurn
    for (let i = snapshot.events.length - 1; i >= 0; i--) {
      const e = snapshot.events[i];
      if (e.turn === currentTurn && e.type !== 'system') return { hasOpenTurn: true, ownerAgentId: e.agentId || null };
    }
    return { hasOpenTurn: true, ownerAgentId: null };
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
