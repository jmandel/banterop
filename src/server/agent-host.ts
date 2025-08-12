import { startAgents, type AgentHandle } from '$src/agents/factories/agent.factory';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { LLMProviderManager } from '$src/llm/provider-manager';

export class AgentHost {
  private byConversation = new Map<number, AgentHandle>();
  private pending = new Map<number, Promise<AgentHandle>>();
  constructor(private orch: OrchestratorService, private providers: LLMProviderManager) {}

  async ensure(conversationId: number, opts?: { agentIds?: string[] }) {
    console.log('[AgentHost] ensure called', { conversationId, agentIds: opts?.agentIds });
    // If already started, do nothing
    if (this.byConversation.has(conversationId)) {
      console.log('[AgentHost] already running', { conversationId });
      return;
    }
    // If a start is in-flight, await it
    const pending = this.pending.get(conversationId);
    if (pending) {
      console.log('[AgentHost] pending start exists, awaiting', { conversationId });
      await pending;
      return;
    }

    // Start and record the pending promise to dedupe concurrent ensures
    const startPromise = (async (): Promise<AgentHandle> => {
      console.log('[AgentHost] starting agents', { conversationId, agentIds: opts?.agentIds });
      const handle = await startAgents({
        conversationId,
        transport: new InProcessTransport(this.orch),
        providerManager: this.providers,
        agentIds: opts?.agentIds,
        turnRecoveryMode: 'restart',
      });
      this.byConversation.set(conversationId, handle);
      console.log('[AgentHost] started', { conversationId, started: handle.agentsInfo.map(a => a.id) });

      // Proactively nudge guidance for no-message conversations with startingAgentId
      // Do this only once per actual start (not for concurrent ensure callers that awaited pending)
      try { this.orch.pokeGuidance(conversationId); } catch {}
      return handle;
    })();

    this.pending.set(conversationId, startPromise);
    try {
      await startPromise;
    } finally {
      this.pending.delete(conversationId);
    }

    // Nudge already performed inside the single startPromise path
  }

  list(conversationId: number): Array<{ id: string; class?: string }> {
    const h = this.byConversation.get(conversationId);
    if (h) return h.agentsInfo.map(a => ({ id: a.id, class: a.class }));
    // Fallback: if startup resume is in-flight, expose intended agents from runner_registry
    try {
      const rows = this.orch.storage.db
        .prepare(`SELECT agent_id as id FROM runner_registry WHERE conversation_id = ?`)
        .all(conversationId) as Array<{ id: string }>; 
      if (rows.length) return rows.map(r => ({ id: r.id }));
    } catch {}
    return [];
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
