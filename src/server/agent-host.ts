import { startAgents, type AgentHandle } from '$src/agents/factories/agent.factory';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { LLMProviderManager } from '$src/llm/provider-manager';

export class AgentHost {
  private byConversation = new Map<number, AgentHandle>();
  private pending = new Map<number, Promise<AgentHandle>>();
  constructor(private orch: OrchestratorService, private providers: LLMProviderManager) {}

  async ensure(conversationId: number, opts?: { agentIds?: string[] }) {
    // If already started, do nothing
    if (this.byConversation.has(conversationId)) return;
    // If a start is in-flight, await it
    const pending = this.pending.get(conversationId);
    if (pending) {
      await pending;
      return;
    }

    // Start and record the pending promise to dedupe concurrent ensures
    const startPromise = (async (): Promise<AgentHandle> => {
      const handle = await startAgents({
        conversationId,
        transport: new InProcessTransport(this.orch),
        providerManager: this.providers,
        agentIds: opts?.agentIds,
        turnRecoveryMode: 'restart',
      });
      this.byConversation.set(conversationId, handle);
      return handle;
    })();

    this.pending.set(conversationId, startPromise);
    try {
      await startPromise;
    } finally {
      this.pending.delete(conversationId);
    }

    // Proactively nudge guidance for no-message conversations with startingAgentId
    try { (this.orch as any).pokeGuidance?.(conversationId); } catch {}
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
