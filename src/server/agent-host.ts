import { startAgents, type AgentHandle } from '$src/agents/factories/agent.factory';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { LLMProviderManager } from '$src/llm/provider-manager';

export class AgentHost {
  private byConversation = new Map<number, AgentHandle>();
  constructor(private orch: OrchestratorService, private providers: LLMProviderManager) {}

  async ensure(conversationId: number, opts?: { agentIds?: string[] }) {
    if (this.byConversation.has(conversationId)) return;

    const handle = await startAgents({
      conversationId,
      transport: new InProcessTransport(this.orch),
      providerManager: this.providers,
      agentIds: opts?.agentIds,
      turnRecoveryMode: 'restart',
    });
    this.byConversation.set(conversationId, handle);

    // Persist autoRun metadata (and optional agent subset)
    const convo = this.orch.getConversationWithMetadata(conversationId);
    if (convo) {
      const custom: any = { ...(convo.metadata.custom || {}) };
      custom.autoRun = true;
      if (opts?.agentIds && opts.agentIds.length > 0) {
        custom.autoRunAgents = Array.from(new Set(opts.agentIds));
      }
      this.orch.storage.conversations.updateMeta(conversationId, { ...convo.metadata, custom });
    }
  }

  list(conversationId: number): Array<{ id: string; class?: string }> {
    const h = this.byConversation.get(conversationId);
    if (!h) return [];
    return h.agents.map(a => ({ id: (a as any).id, class: (a as any).agentClass }));
  }

  async stop(conversationId: number) {
    const h = this.byConversation.get(conversationId);
    if (!h) return;
    await h.stop();
    this.byConversation.delete(conversationId);
  }

  async stopAll() {
    const ids = [...this.byConversation.keys()];
    await Promise.all(ids.map(id => this.stop(id)));
  }
}

