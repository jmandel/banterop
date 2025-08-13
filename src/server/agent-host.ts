import { startAgents, type AgentHandle, type AgentRuntimeInfo } from '$src/agents/factories/agent.factory';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { LLMProviderManager } from '$src/llm/provider-manager';
import type { IAgentHost } from '$src/control/agent-lifecycle.interfaces';

export class AgentHost implements IAgentHost {
  // Maintain composite handles per conversation to allow incremental starts
  private byConversation = new Map<
    number,
    { handles: AgentHandle[]; info: Map<string, AgentRuntimeInfo> }
  >();
  private pending = new Map<number, Promise<void>>();
  constructor(private orch: OrchestratorService, private providers: LLMProviderManager) {}

  async ensure(conversationId: number, opts?: { agentIds?: string[] }) {
    console.log('[AgentHost] ensure called', { conversationId, agentIds: opts?.agentIds });
    const inflight = this.pending.get(conversationId);
    if (inflight) { console.log('[AgentHost] pending ensure exists, awaiting', { conversationId }); await inflight; return; }

    const bucket = this.byConversation.get(conversationId);
    const alreadyRunning = new Set(bucket ? Array.from(bucket.info.keys()) : []);
    const requested = opts?.agentIds && opts.agentIds.length > 0 ? opts.agentIds : undefined;
    const toStart = requested ? requested.filter((id) => !alreadyRunning.has(id)) : undefined;

    // If we have some runtime and nothing new requested, we're done
    if (bucket && (!toStart || toStart.length === 0)) return;

    const p = (async () => {
      console.log('[AgentHost] starting agents', { conversationId, agentIds: toStart ?? requested });
      const handle = await startAgents({
        conversationId,
        transport: new InProcessTransport(this.orch),
        providerManager: this.providers,
        agentIds: toStart ?? requested, // if undefined, start all from config
        turnRecoveryMode: 'restart',
      });

      const bin = this.byConversation.get(conversationId) ?? { handles: [], info: new Map<string, AgentRuntimeInfo>() };
      bin.handles.push(handle);
      for (const info of handle.agentsInfo) bin.info.set(info.id, info);
      this.byConversation.set(conversationId, bin);

      console.log('[AgentHost] started', { conversationId, started: handle.agentsInfo.map(a => a.id) });

      // Proactively nudge guidance for no-message conversations with startingAgentId
      try { this.orch.pokeGuidance(conversationId); } catch {}
    })();

    this.pending.set(conversationId, p);
    try { await p; } finally { this.pending.delete(conversationId); }
  }

  list(conversationId: number): Array<{ id: string; class?: string }> {
    const bucket = this.byConversation.get(conversationId);
    if (bucket) return Array.from(bucket.info.values()).map(a => ({ id: a.id, class: a.class }));
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
    const bucket = this.byConversation.get(conversationId);
    if (!bucket) return;
    const handles = bucket.handles.splice(0, bucket.handles.length);
    for (const h of handles) {
      try { await h.stop(); } catch {}
    }
    this.byConversation.delete(conversationId);
  }

  async stopAll() {
    const ids = [...this.byConversation.keys()];
    await Promise.all(ids.map(id => this.stop(id)));
  }
}
