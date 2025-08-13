import type { IAgentLifecycleManager, IAgentRegistry, IAgentHost } from '$src/control/agent-lifecycle.interfaces';

export class ServerAgentLifecycleManager implements IAgentLifecycleManager {
  constructor(private registry: IAgentRegistry, private host: IAgentHost) {}

  async ensure(conversationId: number, agentIds: string[]) {
    await this.registry.register(conversationId, agentIds);
    await this.host.ensure(conversationId, { agentIds });
    return { ensured: this.host.list(conversationId) };
  }

  async stop(conversationId: number, agentIds?: string[]) {
    await this.registry.unregister(conversationId, agentIds);
    // Current host.stop stops all for the conversation; subset stops are not supported by host.
    await this.host.stop(conversationId);
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
