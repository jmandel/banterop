import type { Storage } from '../orchestrator/storage';
import type { OrchestratorService } from '../orchestrator/orchestrator';
import type { ServerAgentLifecycleManager } from '../control/server-agent-lifecycle';
import type { WatchdogStats } from './watchdog.types';
import type { Conversation } from '$src/db/conversation.store';

const MIN_AGE_MS = 2 * 60 * 1000; // 2 minutes
const MAX_CANCELLATIONS_PER_RUN = 10;
const STARTUP_DELAY_MS = 30 * 1000; // 30 seconds

export { STARTUP_DELAY_MS };

export class ConversationWatchdog {
  private intervalHandle?: Timer;
  private stats: WatchdogStats;
  private isRunning: boolean = false;

  constructor(
    private storage: Storage,
    private orchestrator: OrchestratorService,
    private lifecycleManager: ServerAgentLifecycleManager,
    private intervalMs: number,
    private stalledThresholdMs: number
  ) {
    this.stats = {
      lastCheckTime: new Date(),
      conversationsChecked: 0,
      conversationsCanceled: 0,
      errors: 0
    };
  }

  start(): void {
    if (this.intervalHandle) {
      console.log('[Watchdog] Already running');
      return;
    }

    console.log('[Watchdog] Starting with interval', this.intervalMs, 'ms');
    
    this.intervalHandle = setInterval(() => {
      void this.checkStalled();
    }, this.intervalMs);

    void this.checkStalled();
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
      console.log('[Watchdog] Stopped');
    }
  }

  getStats(): WatchdogStats {
    return { ...this.stats };
  }

  private async checkStalled(): Promise<void> {
    if (this.isRunning) {
      console.log('[Watchdog] Check already in progress, skipping');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      const activeConvos = this.storage.conversations.list({
        status: 'active',
        limit: 1000
      });

      console.log(`[Watchdog] Checking ${activeConvos.length} active conversations`);
      this.stats.conversationsChecked += activeConvos.length;

      const stalledConvos: number[] = [];

      for (const convo of activeConvos) {
        if (await this.isStalled(convo)) {
          stalledConvos.push(convo.conversation);

          if (stalledConvos.length >= MAX_CANCELLATIONS_PER_RUN) {
            console.log('[Watchdog] Reached max cancellations per run');
            break;
          }
        }
      }

      for (const convId of stalledConvos) {
        await this.cancelStalledConversation(convId);
      }

      const duration = Date.now() - startTime;
      console.log(`[Watchdog] Check complete in ${duration}ms, canceled ${stalledConvos.length} conversations`);

    } catch (error) {
      console.error('[Watchdog] Error during check:', error);
      this.stats.errors++;
    } finally {
      this.isRunning = false;
      this.stats.lastCheckTime = new Date();
    }
  }

  private async isStalled(convo: Conversation): Promise<boolean> {
    try {
      const createdAt = new Date(convo.createdAt).getTime();
      const age = Date.now() - createdAt;
      if (age < MIN_AGE_MS) {
        return false;
      }

      const watchdogConfig = convo.metadata.watchdog;
      if (watchdogConfig?.disabled) {
        return false;
      }

      const threshold = watchdogConfig?.stalledThresholdMs ?? this.stalledThresholdMs;

      const head = this.storage.events.getHead(convo.conversation);
      if (!head.lastClosedSeq) {
        return true;
      }

      const lastEvent = this.storage.events.getEventBySeq(
        convo.conversation,
        head.lastClosedSeq
      );

      if (!lastEvent) {
        return false;
      }

      const lastEventTime = new Date(lastEvent.ts).getTime();
      const timeSinceLastEvent = Date.now() - lastEventTime;

      return timeSinceLastEvent > threshold;

    } catch (error) {
      console.error(`[Watchdog] Error checking conversation ${convo.conversation}:`, error);
      return false;
    }
  }

  private async cancelStalledConversation(conversationId: number): Promise<void> {
    console.log(`[Watchdog] Canceling stalled conversation ${conversationId}`);

    try {
      try {
        await this.lifecycleManager.stop(conversationId);
        console.log(`[Watchdog] Stopped agents for conversation ${conversationId}`);
      } catch (error) {
        console.error(`[Watchdog] Failed to stop agents for ${conversationId}:`, error);
      }

      const head = this.storage.events.getHead(conversationId);
      let lastEventTs: string | undefined;
      
      if (head.lastClosedSeq) {
        const lastEvent = this.storage.events.getEventBySeq(conversationId, head.lastClosedSeq);
        if (lastEvent) {
          lastEventTs = lastEvent.ts;
        }
      }

      await this.orchestrator.appendEvent({
        type: 'system',
        finality: 'none',
        agentId: 'system-watchdog',
        payload: {
          kind: 'idle_timeout',
          data: { lastEventTs }
        },
        conversation: conversationId
      });

      await this.orchestrator.appendEvent({
        type: 'message',
        finality: 'conversation',
        agentId: 'system-watchdog',
        payload: {
          text: 'Auto-canceled after idle timeout.',
          outcome: { status: 'canceled', reason: 'idle_timeout' }
        },
        conversation: conversationId
      });

      console.log(`[Watchdog] Successfully canceled conversation ${conversationId}`);
      this.stats.conversationsCanceled++;

    } catch (error) {
      console.error(`[Watchdog] Failed to cancel conversation ${conversationId}:`, error);
      this.stats.errors++;
      throw error;
    }
  }
}