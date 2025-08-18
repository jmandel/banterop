import type { IAgentLifecycleManager, IAgentRegistry, IAgentHost } from '$src/control/agent-lifecycle.interfaces';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { UnifiedEvent } from '$src/types/event.types';

export class ServerAgentLifecycleManager implements IAgentLifecycleManager {
  private orchestrator?: OrchestratorService;
  private subId?: string;

  constructor(private registry: IAgentRegistry, private host: IAgentHost) {}

  // Subscribe to conversation events to auto-stop agents on terminal messages
  async initialize(orchestrator: OrchestratorService) {
    this.orchestrator = orchestrator;
    try {
      this.subId = orchestrator.subscribeAll(async (evt: UnifiedEvent | any) => {
        try {
          if (evt && evt.type === 'message' && evt.finality === 'conversation') {
            const conversationId = (evt as UnifiedEvent).conversation;
            try {
              await this.stop(conversationId);
              // Optional: console.log(`[Lifecycle] Auto-stopped agents for conversation ${conversationId}`);
            } catch (e) {
              console.error('[Lifecycle] Auto-stop failed for conversation', conversationId, e);
            }
          }
        } catch (e) {
          // best-effort; do not throw from subscription
          console.error('[Lifecycle] Subscription handler error', e);
        }
      }, false);
    } catch (e) {
      console.error('[Lifecycle] Failed to initialize subscription', e);
    }
  }

  async shutdown() {
    try {
      if (this.orchestrator && this.subId) {
        this.orchestrator.unsubscribe(this.subId);
      }
    } catch (e) {
      console.error('[Lifecycle] Failed to unsubscribe during shutdown', e);
    } finally {
      this.subId = undefined;
      this.orchestrator = undefined;
    }
  }

  async ensure(conversationId: number, agentIds: string[]) {
    await this.registry.register(conversationId, agentIds);
    await this.host.ensure(conversationId, { agentIds });
    return { ensured: this.host.list(conversationId) };
  }

  async stop(conversationId: number, agentIds?: string[]) {
    await this.registry.unregister(conversationId, agentIds);

    if (!agentIds || agentIds.length === 0) {
      // Stop everything
      await this.host.stop(conversationId);
      return;
    }

    // Per-agent stop semantics: stop current runtime, then re-ensure remaining from registry (if any)
    const all = await this.registry.listRegistered();
    const entry = all.find((e) => e.conversationId === conversationId);
    const remaining = entry?.agentIds ?? [];
    await this.host.stop(conversationId);
    if (remaining.length > 0) {
      await this.host.ensure(conversationId, { agentIds: remaining });
    }
  }

  async resumeAll(): Promise<void> {
    const entries = await this.registry.listRegistered();
    for (const { conversationId, agentIds } of entries) {
      await this.host.ensure(conversationId, { agentIds });
    }
  }

  listRuntime(conversationId: number) {
    return this.host.list(conversationId);
  }

  async clearOthers(keepConversationId: number): Promise<void> {
    const entries = await this.registry.listRegistered();
    for (const { conversationId } of entries) {
      if (conversationId !== keepConversationId) {
        try { await this.host.stop(conversationId); } catch {}
        try { await this.registry.unregister(conversationId); } catch {}
      }
    }
  }
}
