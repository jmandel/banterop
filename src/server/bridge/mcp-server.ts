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
import type { ServerAgentLifecycleManager } from '$src/server/control/server-agent-lifecycle';
import type { UnifiedEvent } from '$src/types/event.types';
import type { AgentMeta } from '$src/types/conversation.meta';
import {
  parseConversationMetaFromConfig64,
  getStartingAgentId,
  type ConvConversationMeta,
} from '$src/server/bridge/conv-config.types';
import { startAgents } from '$src/agents/factories/agent.factory';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import { sha256Base64Url } from '$src/lib/hash';

export interface McpBridgeDeps {
  orchestrator: OrchestratorService;
  providerManager: LLMProviderManager;
  replyTimeoutMs?: number;
  lifecycle: ServerAgentLifecycleManager;
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

    // begin_chat_thread: no idempotency; returns { conversationId: string }
    s.registerTool('begin_chat_thread', { inputSchema: {}, description: toolDoc.begin }, async () => {
      const conversationId = await this.beginChatThread(convMeta);
      const obj = { conversationId: String(conversationId) };
      return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj } as any;
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

        // Determine the correct turn number
        const head = (this.deps.orchestrator as any).storage.events.getHead(conversationId);
        const turn = head.hasOpenTurn ? head.lastTurn : head.lastTurn + 1;

        // Send message with the correct turn
        this.deps.orchestrator.sendMessage(
          conversationId,
          turn,
          startingId,
          { text, ...(attachments ? { attachments } : {}) },
          'turn'
        );

        // Send-only: no polling here; advise caller to check for replies next
        const guidance = 'Message sent. Check for replies by calling check_replies (waitMs=10000 recommended).';
        const status: 'working' = 'working';
        const obj = { ok: true, guidance, status } as const;
        return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj } as any;
      }
    );

    // get_updates: messages-only; expand attachments inline
    // Removed get_updates: callers should use check_replies for a simplified view

    // Convenience: check_replies returns only simplified messages since the last external message
    s.registerTool(
      'check_replies',
      { inputSchema: { conversationId: z.string(), waitMs: z.number().default(10000), max: z.number().default(200) }, description: 'Return simplified replies since the last external message.' },
      async (params: any) => {
        const conversationId = Number(params?.conversationId);
        const waitMs = Number(params?.waitMs ?? 10000);
        const max = Number(params?.max ?? 200);

        const convMeta = parseConversationMetaFromConfig64(this.config64);
        const external = getStartingAgentId(convMeta);
        const boundarySeq = this.getLastExternalMessageSeq(conversationId, external);
        const events = await this.getMessageEvents({ conversationId, sinceSeq: boundarySeq, max, waitMs });
        const filtered = events.filter(e => e.agentId !== external);
        const simplified = await this.simplifyMessages(conversationId, filtered, external);
        // Guidance / status / ended
        const snapshot = this.deps.orchestrator.getConversationSnapshot(conversationId, { includeScenario: false });
        const msgs = (snapshot.events || []).filter((e: any) => e.type === 'message');
        const last = msgs.length ? msgs[msgs.length - 1] : null;
        const ended = snapshot.status === 'completed' || (last && last.finality === 'conversation');

        let status: 'input-required' | 'working' | 'completed' = 'working';
        let guidance = '';
        if (ended) {
          status = 'completed';
          guidance = 'Conversation ended. No further input is expected.';
        } else if (!last) {
          status = 'input-required';
          guidance = `It\'s your turn to begin as ${external}.`;
        } else if (last.finality === 'turn') {
          if (last.agentId !== external) {
            status = 'input-required';
            guidance = `Agent ${last.agentId} finished a turn. It\'s your turn to respond.`;
          } else {
            const others = (convMeta.agents || []).map(a => a.id).filter(id => id !== external);
            const target = others.length === 1 ? `agent ${others[0]}` : `agents ${others.join(', ')}`;
            guidance = `You finished a turn. Waiting for ${target} to respond.`;
          }
        } else {
          if (last.agentId === external) {
            guidance = 'You have an in‑progress turn. Finish or wait for reply.';
          } else {
            guidance = `Agent ${last.agentId} is composing. Waiting for them to finish.`;
          }
        }

        // Add an explicit instruction for polling when we are waiting
        if (!ended && status === 'working') {
          guidance += ' Keep checking for replies (call check_replies again).';
        }

        // Return only messages + guidance/status/ended per spec (no threadText/nextSeq)
        // Avoid confusing states: if no new replies detected, report waiting
        if (!ended && simplified.messages.length === 0) {
          status = 'working';
          guidance = 'No new replies yet. Keep checking for replies (call check_replies again).';
        }

        const obj = { messages: simplified.messages, guidance, status, conversation_ended: ended } as const;
        return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj } as any;
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
      agentSummaries = (meta.agents || []).map((a) => `${a.id}`);
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
    const { orchestrator } = this.deps;
    // Stable template-derived hash for matching: base64url(sha256(config64))
    const bridgeConfig64Hash = await sha256Base64Url(this.config64);

    // Create conversation directly from meta (aligned with CreateConversationRequest)
    // Build agents array with proper optional handling
    const agents: AgentMeta[] = meta.agents.map(a => {
      const agent: AgentMeta = {
        id: a.id,
      };
      if (a.agentClass !== undefined) agent.agentClass = a.agentClass;
      // role, displayName, avatarUrl removed
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

    // Start internal agents only (exclude the external/MCP agent) and PERSIST via lifecycle
    const startingId = getStartingAgentId(meta);
    const internalIds = agents.map(a => a.id).filter(id => id !== startingId);
    if (internalIds.length > 0) {
      await this.deps.lifecycle.ensure(conversationId, internalIds);
    }

    return conversationId;
  }

  // hashed via shared util

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

    // If there are already messages since sinceSeq, return immediately (no wait)
    const existing = fetchNow();
    if (existing.length > 0) {
      return await this.expandAttachmentsInline(existing);
    }

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
      if (!got) {
        // No new events during wait; return any that might have arrived and were missed in the quick check
        const afterWait = fetchNow();
        return await this.expandAttachmentsInline(afterWait);
      }
    }
    const msgs = fetchNow();
    return await this.expandAttachmentsInline(msgs);
  }

  // Compute the sequence number of the last message authored by the external (bridged) agent
  private getLastExternalMessageSeq(conversationId: number, externalAgentId: string): number {
    const all = this.deps.orchestrator.getEventsPage(conversationId, undefined, 1_000_000);
    let last = 0;
    for (const e of all) {
      if (e.type === 'message' && e.agentId === externalAgentId) last = e.seq;
    }
    return last;
  }

  // Produce a simplified representation of messages and an email-like aggregate text
  private async simplifyMessages(conversationId: number, events: UnifiedEvent[], externalAgentId: string): Promise<{ messages: Array<{ from: string; at: string; text: string; attachments?: Array<{ name: string; contentType: string; summary?: string; docId?: string }> }>; threadText: string }>{
    // Expand attachments inline (content is not included in simplified list to keep it concise)
    const expanded = await this.expandAttachmentsInline(events);
    const messages = expanded
      .filter(e => e.type === 'message')
      .map(e => {
        const payload: any = e.payload || {};
        const atts = Array.isArray(payload.attachments) ? payload.attachments : [];
        return {
          from: e.agentId,
          at: e.ts,
          text: String(payload.text ?? ''),
          // Do not expose internal ids/docIds. Include inline content for textual types per design.
          attachments: atts.map((a: any) => {
            const base: any = { name: a.name, contentType: a.contentType };
            if (a.summary) base.summary = a.summary;
            base.content = a.content;
            return base;
          })
        };
      });
    const parts: string[] = [];
    for (const m of messages) {
      parts.push(`From: ${m.from}`);
      parts.push(`Time: ${m.at}`);
      parts.push('');
      parts.push(m.text);
      if (m.attachments && m.attachments.length) {
        parts.push('');
        parts.push('Attachments:');
        for (const att of m.attachments) {
          const bits = [att.name, `(${att.contentType})`];
          if (att.summary) bits.push(`- ${att.summary}`);
          parts.push(`- ${bits.join(' ')}`);
        }
      }
      parts.push('\n---');
    }
    const threadText = parts.join('\n');
    return { messages, threadText };
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
            // Keep id/content internally if needed, but do not attach docId in any outward-facing structures
            atts.push({ id: att.id, name: att.name, contentType: att.contentType, content: att.content, ...(att.summary ? { summary: att.summary } : {}) });
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
