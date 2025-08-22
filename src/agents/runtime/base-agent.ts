// src/agents/runtime/base-agent.ts
// Simplified BaseAgent that relies entirely on orchestrator guidance.
// No reconciliation loop: we only act when we receive a guidance event
// that explicitly tells *this* agent to start or continue a turn.
//
// Assumptions guaranteed by orchestrator:
// - Guidance is emitted on conversation creation if startingAgentId is set.
// - Guidance is emitted after every turn-closing message.
// - Guidance can also be requested as a "snapshot" on subscription (includeGuidance=true).
//
// Behavior:
// - If guidance.nextAgentId !== this agent, we ignore it.
// - If guidance.kind === 'start_turn': we start a new turn immediately.
// - If guidance.kind === 'continue_turn':
//      - If turnRecoveryMode === 'restart', we clear the open turn (abort marker) then continue.
//      - Else, we continue the open turn as-is.
// - We never attempt to infer ownership or reconcile; orchestrator is the source of truth.

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
  currentTurnNumber?: number; // authoritative turn provided by guidance
  snapshot: TSnap;            // snapshot at turn start (best-effort mirror)
  transport: IAgentTransport;
  getLatestSnapshot(): TSnap; // live mirror (best-effort)
}

export type TurnRecoveryMode = 'resume' | 'restart';

export abstract class BaseAgent<TSnap = any> {
  private events?: IAgentEvents;
  private liveSnapshot?: TSnap;
  protected running = false;
  private inTurn = false;
  private unsubscribe?: () => void;

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

    // Create event stream with guidance enabled (authoritative scheduling)
    logLine(agentId, 'debug', `Creating event stream (includeGuidance=true)`);
    this.events = this.transport.createEventStream(conversationId, true);

    // Initialize live snapshot (best-effort; guidance drives turns)
    logLine(agentId, 'debug', `Fetching initial snapshot`);
    this.liveSnapshot = await this.transport.getSnapshot(conversationId, { includeScenario: true }) as TSnap;

    // Subscribe to unified events + guidance
    this.unsubscribe = this.events.subscribe(async (ev) => {
      if (!this.running) return;

      // Guidance events (transient, not persisted)
      if ((ev as any).type === 'guidance') {
        const g = ev as GuidanceEvent;
        const forUs = g.nextAgentId === agentId;
        logLine(agentId, 'guidance', `Received guidance: agent=${g.nextAgentId}, kind=${g.kind}, turn=${g.turn}, forUs=${forUs}`);
        if (!forUs) return;

        // Start/continue the instructed turn
        await this.handleGuidance(conversationId, agentId, g);
        return;
      }

      // Persisted events: append to live snapshot and detect completion
      const ue = ev as UnifiedEvent;
      this.applyUnifiedEventToSnapshot(ue);

      if (ue.type === 'message' && ue.finality === 'conversation') {
        logLine(agentId, 'complete', 'Conversation completed, stopping agent');
        this.stop();
      }
    });

    // NOTE: Because includeGuidance=true, subscription will immediately
    // receive a one-shot authoritative guidance snapshot (if applicable).
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    try { this.unsubscribe?.(); } catch {}
    this.unsubscribe = undefined;
    this.events = undefined;
    this.liveSnapshot = undefined;
  }

  protected abstract takeTurn(ctx: TurnContext<TSnap>): Promise<void>;

  // ---- Internals ----

  private async handleGuidance(conversationId: number, agentId: string, g: GuidanceEvent) {
    if (!this.running) return;

    // Avoid concurrent turn execution
    if (this.inTurn) {
      logLine(agentId, 'debug', `Already in turn; ignoring guidance seq=${g.seq}`);
      return;
    }

    // Optional recovery policy for continue_turn
    if (g.kind === 'continue_turn' && this.turnRecoveryMode === 'restart') {
      try {
        const { turn } = await this.transport.clearTurn(conversationId, agentId);
        logLine(agentId, 'abort', `Cleared open turn ${turn} per restart policy`);
      } catch (err) {
        logLine(agentId, 'warn', `Failed to clear turn before continue: ${err}`);
      }
    }

    // Refresh a snapshot for this turn start (best-effort)
    try {
      this.liveSnapshot = await this.transport.getSnapshot(conversationId, { includeScenario: true }) as TSnap;
    } catch (err) {
      logLine(agentId, 'warn', `Failed to refresh snapshot before turn: ${err}`);
    }

    // Execute the turn
    this.inTurn = true;
    try {
      const ctx: TurnContext<TSnap> = {
        conversationId,
        agentId,
        guidanceSeq: g.seq,
        deadlineMs: g.deadlineMs ?? (Date.now() + 30000),
        currentTurnNumber: g.turn,
        snapshot: this.clone(this.liveSnapshot!),
        transport: this.transport,
        getLatestSnapshot: () => this.clone(this.liveSnapshot!),
      };
      logLine(agentId, 'turn', `Executing ${g.kind} at turn=${g.turn}`);
      await this.takeTurn(ctx);
    } catch (err) {
      logLine(agentId, 'error', `Error during turn execution: ${err}`);
    } finally {
      this.inTurn = false;
    }
  }

  private applyUnifiedEventToSnapshot(ev: UnifiedEvent) {
    if (!this.liveSnapshot) return;
    const snap: any = this.liveSnapshot as any;
    snap.events = [...(snap.events ?? []), ev];

    if (ev.type === 'message' && ev.finality === 'conversation') {
      snap.status = 'completed';
    }
    if (ev.type === 'message' && ev.finality !== 'none' && ev.seq) {
      snap.lastClosedSeq = ev.seq;
    }
  }

  private clone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }
}
