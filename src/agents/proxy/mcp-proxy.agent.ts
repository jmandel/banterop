import { BaseAgent, type TurnContext } from '$src/agents/runtime/base-agent';
import type { IAgentTransport } from '$src/agents/runtime/runtime.interfaces';
import type { LLMProviderManager } from '$src/llm/provider-manager';
import { RemoteMcpHttpClient } from '$src/server/bridge/mcp-http.client';
import type { UnifiedEvent } from '$src/types/event.types';

export type McpProxyConfig = {
  remoteBaseUrl: string;
  headers?: Record<string, string>;
  bridgedAgentId: string;        // external-facing identity (mirrored locally as this id)
  counterpartyAgentId: string;   // local scenario agent to forward to remote
  remoteConversationId?: string; // optional if already created remotely
  waitMs?: number;               // default poll wait (ms)
};

export class McpProxyAgent extends BaseAgent<any> {
  private client: RemoteMcpHttpClient;
  private cfg: McpProxyConfig;
  private remoteConversationId: string | null = null;
  private lastPushedSeq = 0;

  constructor(transport: IAgentTransport, cfg: McpProxyConfig, _providers?: LLMProviderManager) {
    super(transport, { turnRecoveryMode: 'resume' });
    this.cfg = cfg;
    this.client = new RemoteMcpHttpClient({ baseUrl: cfg.remoteBaseUrl, headers: cfg.headers, timeoutMs: 15000 });
    this.remoteConversationId = cfg.remoteConversationId ?? null;
  }

  protected async takeTurn(ctx: TurnContext<any>): Promise<void> {
    const { conversationId } = ctx;

    // Ensure remote conversation
    if (!this.remoteConversationId) {
      const begin = await this.client.beginChatThread();
      this.remoteConversationId = begin.conversationId;
    }

    // Snapshot for local events
    const snap = ctx.snapshot as any;
    const events: UnifiedEvent[] = snap.events || [];

    // Push new local messages from counterparty to remote
    const outgoing = events
      .filter(e => e.type === 'message' && e.agentId === this.cfg.counterpartyAgentId && e.seq > this.lastPushedSeq);

    for (const m of outgoing) {
      const text = (m.payload as any)?.text ?? '';
      if (text) {
        await this.client.sendMessage({ conversationId: this.remoteConversationId!, message: text });
      }
      this.lastPushedSeq = Math.max(this.lastPushedSeq, m.seq);
    }

    // Pull remote replies since last external boundary
    const waitMs = this.cfg.waitMs ?? 1000;
    const replies = await this.client.checkReplies({ conversationId: this.remoteConversationId!, waitMs });

    if (Array.isArray(replies.messages) && replies.messages.length > 0) {
      const ended = !!(replies as any).conversation_ended;
      for (let i = 0; i < replies.messages.length; i++) {
        const r = replies.messages[i]!;
        const text = String((r as any).text ?? '');
        if (!text) continue;
        const isLast = i === replies.messages.length - 1;
        const finality = ended && isLast ? 'conversation' : 'turn';
        await this.transport.postMessage({ conversationId, agentId: this.cfg.bridgedAgentId, text, finality });
      }
    }
  }
}
