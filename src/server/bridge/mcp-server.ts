// src/server/bridge/mcp-server.ts
//
// McpBridgeServer – updated to accept a generic base64url ConversationMeta config.
// begin_chat_thread will create a conversation from the provided meta and start internal agents
// (based on agentClass). The startingAgentId will be the initiator.
//
// Tools: begin_chat_thread, send_message_to_chat_thread, get_updates
// - bare-key zod schemas for MCP TS SDK compatibility
// - conversationId is a string on the wire (numeric ids serialized as strings)
// - get_updates returns message events only; attachments expanded inline
//

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { LLMProviderManager } from '$src/llm/provider-manager';
import type { UnifiedEvent } from '$src/types/event.types';
import type { AgentMeta } from '$src/types/conversation.meta';
import {
  parseConversationMetaFromConfig64,
  getStartingAgentId,
  type ConvConversationMeta,
} from '$src/server/bridge/conv-config.types';
import { startAgents } from '$src/agents/factories/agent.factory';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';

export interface McpBridgeDeps {
  orchestrator: OrchestratorService;
  providerManager: LLMProviderManager;
  replyTimeoutMs?: number;
}

export class McpBridgeServer {
  constructor(
    private deps: McpBridgeDeps,
    private config64: string,
    private sessionId: string
  ) {}

  async handleRequest(req: any, res: any, body: any): Promise<void> {
    const convMeta = parseConversationMetaFromConfig64(this.config64);
    const mcp = await this.buildServerWithContext(convMeta);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private timeoutMs(): number {
    // Default 1500ms per design doc
    return this.deps.replyTimeoutMs ?? 1500;
  }

  private async buildServerWithContext(convMeta: ConvConversationMeta): Promise<McpServer> {
    const s = new McpServer({ name: 'lfi-mcp-bridge', version: '1.0.0' });
    const toolDoc = this.buildToolDescription(convMeta);

    // begin_chat_thread: no idempotency; returns { conversationId: string, nextSeq: number }
    s.registerTool('begin_chat_thread', { inputSchema: {}, description: toolDoc.begin }, async () => {
      const conversationId = await this.beginChatThread(convMeta);
      const nextSeq = this.getNextSeq(conversationId);
      return { content: [{ type: 'text', text: JSON.stringify({ conversationId: String(conversationId), nextSeq }) }] };
    });

    // send_message_to_chat_thread: post message and opportunistically return reply events
    s.registerTool(
      'send_message_to_chat_thread',
      {
        inputSchema: {
          conversationId: z.string(),
          message: z.string(),
          attachments: z.array(
            z.object({
              name: z.string(),
              contentType: z.string(),
              content: z.string(),
              summary: z.string().optional(),
              docId: z.string().optional(),
            })
          ).optional(),
        },
        description: toolDoc.send
      },
      async (params: any) => {
        const meta = parseConversationMetaFromConfig64(this.config64);
        const startingId = getStartingAgentId(meta);
        const conversationId = Number(params?.conversationId);
        const text = String(params?.message ?? '');
        const attachments = Array.isArray(params?.attachments) ? params.attachments : undefined;

        // Send message
        this.deps.orchestrator.sendMessage(
          conversationId,
          startingId,
          { text, ...(attachments ? { attachments } : {}) },
          'turn'
        );

        // Opportunistic wait for a reply from counterparty and return events
        const startSeq = this.getNextSeq(conversationId);
        const events = await this.waitForNewMessageEvents({ conversationId, sinceSeq: startSeq, excludeAgentId: startingId });
        const nextSeq = this.getNextSeq(conversationId);
        return { content: [{ type: 'text', text: JSON.stringify({ events, nextSeq, stillWorking: events.length === 0 }) }] };
      }
    );

    // get_updates: messages-only; expand attachments inline
    s.registerTool(
      'get_updates',
      { inputSchema: { conversationId: z.string(), sinceSeq: z.number().default(0), max: z.number().default(200), waitMs: z.number().default(0) }, description: toolDoc.updates },
      async (params: any) => {
        const conversationId = Number(params?.conversationId);
        const sinceSeq = Number(params?.sinceSeq ?? 0);
        const max = Number(params?.max ?? 200);
        const waitMs = Number(params?.waitMs ?? 0);

        const events = await this.getMessageEvents({ conversationId, sinceSeq, max, waitMs });
        const nextSeq = this.getNextSeq(conversationId);

        // Guidance and status computation
        const snapshot = this.deps.orchestrator.getConversationSnapshot(conversationId, { includeScenario: false });
        const convMeta = parseConversationMetaFromConfig64(this.config64);
        const externalId = getStartingAgentId(convMeta);
        const msgs = (snapshot.events || []).filter((e: any) => e.type === 'message');
        const last = msgs.length ? msgs[msgs.length - 1] : null;
        const ended = snapshot.status === 'completed' || (last && last.finality === 'conversation');

        let status: 'input_required' | 'waiting' = 'waiting';
        let guidance = '';
        if (ended) {
          guidance = 'Conversation ended. No further input is expected.';
        } else if (!last) {
          // No messages yet: whoever is starting should speak
          if (externalId) {
            status = 'input_required';
            guidance = `It\'s your turn to begin as ${externalId}.`;
          } else {
            guidance = 'Waiting for the first message.';
          }
        } else if (last.finality === 'turn') {
          // A turn just completed; if the last speaker was not the external client, it is the client\'s turn
          if (last.agentId !== externalId) {
            status = 'input_required';
            guidance = 'Counterparty finished a turn. It\'s your turn to respond.';
          } else {
            guidance = 'You finished a turn. Waiting for the counterparty to respond.';
          }
        } else {
          // Turn in progress – wait
          if (last.agentId === externalId) {
            guidance = 'You have an in‑progress turn. Finish or wait for reply.';
          } else {
            guidance = 'Counterparty is composing. Waiting for the other party to finish.';
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ events, nextSeq, guidance, status, conversation_ended: ended })
          }]
        };
      }
    );

    return s;
  }

  private buildToolDescription(meta: ConvConversationMeta): { begin: string; send: string; updates: string } {
    const { orchestrator } = this.deps;
    const scId = meta.scenarioId;
    let title = meta.title || '';
    let agentSummaries: string[] = [];
    try {
      if (scId) {
        const sc = orchestrator.storage.scenarios.findScenarioById(scId);
        if (sc) {
          title = title || sc.config?.metadata?.title || sc.name || sc.id;
          agentSummaries = (sc.config?.agents || []).map((a: any) => {
            const n = a?.principal?.name || a?.agentId || '';
            return `${a.agentId}${n && n !== a.agentId ? ` (${n})` : ''}`;
          });
        }
      }
    } catch {}
    if (agentSummaries.length === 0) {
      agentSummaries = (meta.agents || []).map((a) => `${a.id}${a.displayName ? ` (${a.displayName})` : ''}${a.role ? ` – ${a.role}` : ''}`);
    }
    const roleLine = `Agents: ${agentSummaries.join(', ')}`;
    const scenarioLine = `Scenario: ${title || scId || 'unknown'}`;
    const external = meta.startingAgentId || (meta.agents?.[0]?.id ?? '');
    const begin = `Begin a new chat thread for ${scenarioLine}. ${roleLine}. External client will speak as: ${external}.`;
    const send = `Send a message into an existing thread as the external client (${external}). ${roleLine}.`;
    const updates = `Fetch message updates for a thread (messages only). ${scenarioLine}.`;
    return { begin, send, updates };
  }

  /**
   * Create conversation from conversation meta (base64), then start internal agents.
   * The external agent (startingAgentId) will kick off by sending the first message.
   */
  private async beginChatThread(meta: ConvConversationMeta): Promise<number> {
    const { orchestrator, providerManager } = this.deps;
    // Stable template-derived hash for matching: base64url(sha256(config64))
    const bridgeConfig64Hash = await this.sha256Base64Url(this.config64);

    // Create conversation directly from meta (aligned with CreateConversationRequest)
    // Build agents array with proper optional handling
    const agents: AgentMeta[] = meta.agents.map(a => {
      const agent: AgentMeta = {
        id: a.id,
      };
      if (a.agentClass !== undefined) agent.agentClass = a.agentClass;
      if (a.role !== undefined) agent.role = a.role;
      if (a.displayName !== undefined) agent.displayName = a.displayName;
      if (a.avatarUrl !== undefined) agent.avatarUrl = a.avatarUrl;
      if (a.config !== undefined) agent.config = a.config;
      return agent;
    });
    
    const conversationId = orchestrator.createConversation({
      meta: {
        ...(meta.title !== undefined ? { title: meta.title } : {}),
        ...(meta.description !== undefined ? { description: meta.description } : {}),
        ...(meta.scenarioId !== undefined ? { scenarioId: meta.scenarioId } : {}),
        agents,
        ...(meta.config !== undefined ? { config: meta.config } : {}),
        custom: {
          ...(meta.custom ?? {}),
          bridgeSession: this.sessionId,
          bridgeConfig64Hash,
        },
      },
    });

    // Start internal agents only (exclude the external/MCP agent)
    const startingId = getStartingAgentId(meta);
    const internalIds = agents.map(a => a.id).filter(id => id !== startingId);
    await startAgents({
      conversationId,
      transport: new InProcessTransport(orchestrator),
      providerManager,
      agentIds: internalIds,
    });

    return conversationId;
  }

  // Compute sha-256 over input and return base64url without padding
  private async sha256Base64Url(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    const b64 = btoa(bin);
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private getNextSeq(conversationId: number): number {
    const events = this.deps.orchestrator.getEventsPage(conversationId, undefined, 1_000_000);
    return events.length ? events[events.length - 1]!.seq : 0;
  }

  private async waitForNewMessageEvents(opts: { conversationId: number; sinceSeq: number; excludeAgentId?: string }): Promise<UnifiedEvent[]> {
    const { orchestrator } = this.deps;
    const timeout = this.timeoutMs();
    let resolved = false;
    let timer: any;
    let subId: string | undefined;

    const reply = await new Promise<boolean>((resolve) => {
      subId = orchestrator.subscribe(
        opts.conversationId,
        (e: UnifiedEvent) => {
          try {
            if (e.type !== 'message') return;
            if (opts.excludeAgentId && e.agentId === opts.excludeAgentId) return;
            if (e.seq <= opts.sinceSeq) return;
            if (timer) clearTimeout(timer);
            resolved = true;
            if (subId) orchestrator.unsubscribe(subId);
            resolve(true);
          } catch {
            // ignore
          }
        },
        false
      );

      timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        if (subId) orchestrator.unsubscribe(subId);
        resolve(false);
      }, timeout);
    });

    if (!reply) return [];
    const all = orchestrator.getEventsSince(opts.conversationId, opts.sinceSeq);
    const messages = all.filter((e) => e.type === 'message' && (!opts.excludeAgentId || e.agentId !== opts.excludeAgentId));
    return await this.expandAttachmentsInline(messages);
  }

  private async getMessageEvents(params: { conversationId: number; sinceSeq: number; max: number; waitMs: number }): Promise<UnifiedEvent[]> {
    const { orchestrator } = this.deps;
    const { conversationId, sinceSeq, max, waitMs } = params;
    const fetchNow = () => orchestrator.getEventsPage(conversationId, sinceSeq, max).filter((e) => e.type === 'message');
    if (waitMs > 0) {
      // Long-poll for any new message event
      let subId: string | undefined;
      let timer: any;
      const got = await new Promise<boolean>((resolve) => {
        subId = orchestrator.subscribe(
          conversationId,
          (e: UnifiedEvent) => {
            if (e.type !== 'message') return;
            if (e.seq <= sinceSeq) return;
            if (timer) clearTimeout(timer);
            if (subId) orchestrator.unsubscribe(subId);
            resolve(true);
          },
          false
        );
        timer = setTimeout(() => {
          if (subId) orchestrator.unsubscribe(subId);
          resolve(false);
        }, waitMs);
      });
      if (!got) return [];
    }
    const msgs = fetchNow();
    return await this.expandAttachmentsInline(msgs);
  }

  private async expandAttachmentsInline(events: UnifiedEvent[]): Promise<UnifiedEvent[]> {
    const { orchestrator } = this.deps;
    const expanded: UnifiedEvent[] = [];
    for (const e of events) {
      const payload = (e.payload || {}) as any;
      if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
        const atts = [] as any[];
        for (const a of payload.attachments) {
          if (!a?.id) continue;
          const att = orchestrator.getAttachment(a.id);
          if (att) {
            atts.push({ id: att.id, name: att.name, contentType: att.contentType, content: att.content, ...(att.summary ? { summary: att.summary } : {}), ...(att.docId ? { docId: att.docId } : {}) });
          }
        }
        expanded.push({ ...e, payload: { ...payload, attachments: atts } });
      } else {
        expanded.push(e);
      }
    }
    return expanded;
  }
}
