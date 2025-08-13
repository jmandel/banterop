import type { IAgentHost } from '$src/control/agent-lifecycle.interfaces';
import { startAgents, type AgentHandle, type AgentRuntimeInfo } from '$src/agents/factories/agent.factory';
import { WsTransport } from '$src/agents/runtime/ws.transport';
import { LLMProviderManager } from '$src/llm/provider-manager';

export class BrowserAgentHost implements IAgentHost {
  // Maintain composite handles per conversation to allow incremental starts
  private byConversation = new Map<
    number,
    { handles: AgentHandle[]; info: Map<string, AgentRuntimeInfo> }
  >();
  private pending = new Map<number, Promise<void>>();
  private providerManager: LLMProviderManager;

  constructor(private wsUrl: string, providerManager?: LLMProviderManager) {
    const serverUrl = new URL(this.wsUrl.replace(/^ws/, 'http'));
    // normalize path to server root
    this.providerManager = providerManager ?? new LLMProviderManager({
      defaultLlmProvider: 'browserside',
      serverUrl: `${serverUrl.protocol}//${serverUrl.host}`,
    });
  }

  async ensure(conversationId: number, opts?: { agentIds?: string[] }): Promise<void> {
    const inflight = this.pending.get(conversationId);
    if (inflight) { await inflight; return; }

    const existing = this.byConversation.get(conversationId);
    const alreadyRunning = new Set(existing ? Array.from(existing.info.keys()) : []);
    const requested = opts?.agentIds && opts.agentIds.length > 0 ? opts.agentIds : undefined;
    const toStart = requested ? requested.filter((id) => !alreadyRunning.has(id)) : undefined;

    // If nothing new to start and conversation is already present, done.
    if (existing && (!toStart || toStart.length === 0)) return;

    const p = (async () => {
      const handle = await startAgents({
        conversationId,
        transport: new WsTransport(this.wsUrl),
        providerManager: this.providerManager,
        agentIds: toStart ?? requested, // if undefined, start all from config
        turnRecoveryMode: 'restart',
      });

      const bucket = this.byConversation.get(conversationId) ?? {
        handles: [],
        info: new Map<string, AgentRuntimeInfo>(),
      };
      bucket.handles.push(handle);
      for (const info of handle.agentsInfo) bucket.info.set(info.id, info);
      this.byConversation.set(conversationId, bucket);
    })();

    this.pending.set(conversationId, p);
    try { await p; } finally { this.pending.delete(conversationId); }
  }

  async stop(conversationId: number): Promise<void> {
    const bucket = this.byConversation.get(conversationId);
    if (!bucket) return;
    const handles = bucket.handles.splice(0, bucket.handles.length);
    for (const h of handles) {
      try { await h.stop(); } catch {}
    }
    this.byConversation.delete(conversationId);
  }

  list(conversationId: number): AgentRuntimeInfo[] {
    const bucket = this.byConversation.get(conversationId);
    return bucket ? Array.from(bucket.info.values()) : [];
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.byConversation.keys());
    await Promise.all(ids.map((id) => this.stop(id)));
  }
}
