import type { Agent, Logger } from '$src/agents/agent.types';
import { WsJsonRpcClient } from '$src/agents/clients/ws.client';
import { logLine, colors, PerfTimer } from '$src/lib/utils/logger';

type LoopOptions = {
  conversationId: number;
  agentId: string;
  url: string; // ws://host/api/ws
  decideIfMyTurn?: (events: unknown[]) => boolean;
  pollTimeoutMs?: number;
};

export class ExternalExecutor {
  private running = false;
  private sinceSeq = 0;
  private lastEligibleSeq = 0;
  private aborted = false;
  private client?: WsJsonRpcClient;
  private timer = new PerfTimer();

  constructor(private agent: Agent, private opts: LoopOptions) {}

  async startLoop(): Promise<void> {
    logLine('exec', colors.green(`START LOOP`), `agent=${this.opts.agentId} conv=${this.opts.conversationId}`);
    
    const client = new WsJsonRpcClient({
      url: this.opts.url,
      onEvent: (e: unknown) => this.handlePushEvent(e, client),
      reconnect: false, // Disable reconnect for cleaner shutdown
      agentId: this.opts.agentId,  // Pass agent ID for logging
    } as any);
    this.client = client;

    const snap = await client.getSnapshot(this.opts.conversationId);
    this.sinceSeq = snap.events.length ? (snap.events[snap.events.length - 1] as { seq: number }).seq : 0;
    logLine('exec', 'initial state', `latestSeq=${this.sinceSeq} events=${snap.events.length}`);
    
    // Set up persistent subscription
    await client.ensureSubscribed(this.opts.conversationId);
    logLine('exec', 'persistent subscription established');
    
    // Check if already completed
    if (snap.status === 'completed') {
      logLine('exec', colors.yellow('already completed'));
      return;
    }
    
    // Check if we should start (important for empty conversations)
    if (this.isMyTurn(snap.events)) {
      logLine('exec', colors.green('ELIGIBLE'), 'at startup');
      await this.runOnce(client, 'push');
    }

    const pollTimeoutMs = this.opts.pollTimeoutMs ?? 500; // Reduced timeout
    
    // Poll loop as a backup mechanism (should rarely trigger with push events working)
    while (!this.aborted) {
      // Use waitForChange which now uses persistent subscription
      const waitRes = await client.waitForChange(this.opts.conversationId, this.sinceSeq, pollTimeoutMs);
      
      if (waitRes.timedOut) {
        // Periodic reconciliation - check if we missed something
        logLine('exec', colors.dim('poll reconciliation'), `latestSeq=${waitRes.latestSeq}`);
        
        if (waitRes.latestSeq > this.sinceSeq && !this.running) {
          const snap = await client.getSnapshot(this.opts.conversationId);
          this.sinceSeq = snap.events.length ? (snap.events[snap.events.length - 1] as { seq: number }).seq : this.sinceSeq;
          
          if (snap.status === 'completed') {
            logLine('exec', colors.yellow('COMPLETED'), 'exiting loop');
            return;
          }
          
          if (this.isMyTurn(snap.events)) {
            logLine('exec', colors.green('ELIGIBLE'), 'via poll reconciliation');
            await this.runOnce(client, 'poll');
          }
        }
      }
      
      // Check if conversation is done
      const snap = await client.getSnapshot(this.opts.conversationId);
      if (snap.status === 'completed') {
        logLine('exec', colors.yellow('COMPLETED'), 'exiting loop');
        return;
      }
    }
  }

  private async handlePushEvent(ev: unknown, client: WsJsonRpcClient) {
    const e = ev as { seq: number; type: string; finality?: string; agentId?: string; turn?: number; event?: number };
    logLine('exec', colors.magenta('PUSH EVENT'), `seq=${e.seq} ${e.type}/${e.finality} by=${e.agentId} t=${e.turn}:${e.event}`);
    
    // Update our sequence tracking
    this.sinceSeq = Math.max(this.sinceSeq, e.seq);
    
    if (this.running || this.aborted) {
      logLine('exec', colors.dim('skip'), `running=${this.running} aborted=${this.aborted}`);
      return;
    }
    
    // Fast path: if this is a turn-finalizing message by someone else, it's our turn
    if (e.type === 'message' && e.finality === 'turn' && e.agentId !== this.opts.agentId) {
      // Update lastEligibleSeq to prevent duplicate runs
      if (e.seq > this.lastEligibleSeq) {
        this.lastEligibleSeq = e.seq;
        logLine('exec', colors.green('ELIGIBLE'), `via push (fast path) after ${e.agentId}`);
        await this.runOnce(client, 'push');
      }
      return;
    }
    
    // For other cases (e.g., system events, non-final messages), optionally check
    if (e.type === 'message' && e.finality === 'conversation') {
      logLine('exec', colors.yellow('conversation finalized'), 'stopping');
      this.aborted = true;
    }
  }

  private isMyTurn(events: unknown[]): boolean {
    // Find the last message with turn finality
    const lastTurnMsg = [...events].reverse().find((e) => {
      const typed = e as { type: string; finality?: string };
      return typed.type === 'message' && typed.finality === 'turn';
    });
    
    // Custom logic if provided
    if (this.opts.decideIfMyTurn) {
      return this.opts.decideIfMyTurn(events);
    }
    
    // Default logic: speak if someone else just finished their turn
    if (!lastTurnMsg) {
      // No turn-finalized messages yet - only agent-a starts
      return this.opts.agentId === 'agent-a';
    }
    
    const typed = lastTurnMsg as { agentId: string; seq?: number };
    const seq = typed.seq ?? 0;
    
    // Check if we already responded to this turn
    if (seq <= this.lastEligibleSeq) {
      return false;
    }
    
    // It's my turn if the last turn was completed by someone else
    const myTurn = typed.agentId !== this.opts.agentId;
    if (myTurn) {
      this.lastEligibleSeq = seq;
      logLine('exec', colors.cyan('MY TURN'), `after ${typed.agentId} finished (seq ${seq})`);
    }
    
    return myTurn;
  }

  private async runOnce(client: WsJsonRpcClient, cause: 'push' | 'poll' = 'poll') {
    if (this.running || this.aborted) return;
    this.running = true;
    
    this.timer.start('run');
    logLine(this.opts.agentId, colors.bright('RUN START'), `cause=${cause}`);
    
    try {
      const logger: Logger = {
        debug: (msg: string, _meta?: unknown) => logLine(this.opts.agentId, 'debug', msg),
        info: (msg: string, _meta?: unknown) => logLine(this.opts.agentId, 'info', msg),
        warn: (msg: string, _meta?: unknown) => logLine(this.opts.agentId, colors.yellow('warn'), msg),
        error: (msg: string, _meta?: unknown) => logLine(this.opts.agentId, colors.red('error'), msg),
      };
      
      const ctx = { 
        conversationId: this.opts.conversationId, 
        agentId: this.opts.agentId, 
        deadlineMs: Date.now() + 30_000, 
        client, 
        logger 
      };
      
      await this.agent.handleTurn(ctx);
      // Update sinceSeq to the latest we've seen (updated by push events)
      this.sinceSeq = client.latestSeqSeen;
    } catch (err) {
      logLine(this.opts.agentId, colors.red('ERROR'), String(err));
    } finally {
      const runTime = this.timer.end('run');
      logLine(this.opts.agentId, colors.bright('RUN END'), undefined, runTime);
      this.running = false;
    }
  }
  
  stop(): void {
    logLine('exec', colors.yellow('STOPPING'));
    this.aborted = true;
    if (this.client) {
      this.client.unsubscribe().catch(() => {});
      this.client.close();
    }
  }
}