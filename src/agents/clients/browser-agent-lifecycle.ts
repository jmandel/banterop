import type { IAgentLifecycleManager, IAgentRegistry, IAgentHost } from '$src/control/agent-lifecycle.interfaces';

export class BrowserAgentLifecycleManager implements IAgentLifecycleManager {
  constructor(private registry: IAgentRegistry, private host: IAgentHost) {}

  async ensure(conversationId: number, agentIds: string[]) {
    await this.registry.register(conversationId, agentIds);
    await this.host.ensure(conversationId, { agentIds });
    return { ensured: this.host.list(conversationId) };
  }

  async stop(conversationId: number, agentIds?: string[]) {
    // Update registry first
    await this.registry.unregister(conversationId, agentIds);

    if (!agentIds || agentIds.length === 0) {
      // Stop everything
      await this.host.stop(conversationId);
      return;
    }

    // Per-agent stop: restart with remaining set from registry
    // Read remaining agents for this conversation
    const all = await this.registry.listRegistered();
    const entry = all.find((e) => e.conversationId === conversationId);
    const remaining = entry?.agentIds ?? [];

    // Stop current runtime then re-ensure remaining (if any)
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
