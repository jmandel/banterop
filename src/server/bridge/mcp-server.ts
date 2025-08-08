// src/server/bridge/mcp-server.ts
//
// McpBridgeServer – updated to accept a generic base64url ConversationMeta config.
// begin_chat_thread will create a conversation from the provided meta and start internal agents
// (based on agentClass and kind='internal'). The external startingAgentId will be the initiator.
//
// send_message_to_chat_thread and wait_for_reply remain the same behaviorally, but now derive
// the bridgedAgentId from meta.startingAgentId (or fallback rules).
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
    return this.deps.replyTimeoutMs ?? 15000;
  }

  private async buildServerWithContext(convMeta: ConvConversationMeta): Promise<McpServer> {
    const s = new McpServer({ name: 'lfi-mcp-bridge', version: '1.0.0' });

    s.registerTool(
      'begin_chat_thread',
      {
        title: 'Begin Chat Thread',
        description:
          'Create a new conversation from the provided meta (scenario/title/agents). Internal agents will be started. The startingAgentId (external) should initiate.',
        inputSchema: {},
      },
      async () => {
        const conversationId = await this.beginChatThread(convMeta);
        return { content: [{ type: 'text', text: JSON.stringify({ conversationId }) }] };
      }
    );

    s.registerTool(
      'send_message_to_chat_thread',
      {
        title: 'Send Message to Chat Thread',
        description:
          'Send a message as the starting (external) agent specified by startingAgentId and wait for a reply from an internal counterparty (timeout returns stillWorking).',
        inputSchema: {
          conversationId: z.number(),
          message: z.string(),
          attachments: z.array(z.object({
            name: z.string(),
            contentType: z.string(),
            content: z.string(),
            summary: z.string().optional(),
            docId: z.string().optional(),
          })).optional(),
        },
      },
      async (params: any) => {
        const meta = parseConversationMetaFromConfig64(this.config64); // stateless re-parse
        const startingId = getStartingAgentId(meta);
        const result = await this.sendAndWait({
          conversationId: Number(params?.conversationId),
          agentId: startingId,
          text: String(params?.message ?? ''),
          attachments: Array.isArray(params?.attachments) ? params.attachments : undefined,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
    );

    s.registerTool(
      'wait_for_reply',
      {
        title: 'Wait for Reply',
        description:
          'Wait for the next reply from an internal counterparty without sending a new message (timeout returns stillWorking).',
        inputSchema: {
          conversationId: z.number(),
        },
      },
      async (params: any) => {
        const meta = parseConversationMetaFromConfig64(this.config64);
        const startingId = getStartingAgentId(meta);
        const result = await this.waitForReply({
          conversationId: Number(params?.conversationId),
          bridgedAgentId: startingId,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
    );

    return s;
  }

  /**
   * Create conversation from conversation meta (base64), then start internal agents.
   * The external agent (startingAgentId) will kick off by sending the first message.
   */
  private async beginChatThread(meta: ConvConversationMeta): Promise<number> {
    const { orchestrator, providerManager } = this.deps;

    // Create conversation directly from meta (aligned with CreateConversationRequest)
    // Build agents array with proper optional handling
    const agents: AgentMeta[] = meta.agents.map(a => {
      const agent: AgentMeta = {
        id: a.id,
        kind: a.kind,
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
        },
      },
    });

    // Start agents using unified factory
    await startAgents({
      conversationId,
      transport: new InProcessTransport(orchestrator),
      providerManager
    });

    return conversationId;
  }

  private async sendAndWait(params: {
    conversationId: number;
    agentId: string;
    text: string;
    attachments?: Array<{ name: string; contentType: string; content: string; summary?: string; docId?: string }>;
  }): Promise<
    | { reply: string; attachments?: Array<{ name: string; contentType: string; content: string }> }
    | { stillWorking: true; followUp: string; status: { message: string } }
  > {
    const { orchestrator } = this.deps;

    orchestrator.sendMessage(
      params.conversationId,
      params.agentId,
      { text: params.text, ...(params.attachments !== undefined ? { attachments: params.attachments } : {}) },
      'turn'
    );

    const result = await this.waitForReply({
      conversationId: params.conversationId,
      bridgedAgentId: params.agentId,
    });

    return result;
  }

  private async waitForReply(params: {
    conversationId: number;
    bridgedAgentId: string;
  }): Promise<
    | { reply: string; attachments?: Array<{ name: string; contentType: string; content: string }> }
    | { stillWorking: true; followUp: string; status: { message: string } }
  > {
    const { orchestrator } = this.deps;
    const timeout = this.timeoutMs();

    let resolved = false;
    let timer: any;
    let subId: string | undefined;

    const reply = await new Promise<
      | { reply: string; attachments?: Array<{ name: string; contentType: string; content: string }> }
      | null
    >((resolve) => {
      subId = orchestrator.subscribe(
        params.conversationId,
        (e: UnifiedEvent) => {
          try {
            if (e.type !== 'message') return;
            if (e.agentId === params.bridgedAgentId) return; // ignore initiator echoes
            const payload = (e.payload || {}) as { text?: string; attachments?: Array<{ id: string; name: string; contentType: string }> };
            const text = payload.text ?? '';
            if (!text) return;

            const fetchAttachments = async () => {
              if (!Array.isArray(payload.attachments) || payload.attachments.length === 0) return undefined;
              const full: Array<{ name: string; contentType: string; content: string }> = [];
              for (const a of payload.attachments) {
                if (!a?.id) continue;
                const att = orchestrator.getAttachment(a.id);
                if (att) full.push({ name: att.name, contentType: att.contentType, content: att.content });
              }
              return full.length ? full : undefined;
            };

            void fetchAttachments().then((atts) => {
              if (timer) clearTimeout(timer);
              resolved = true;
              if (subId) orchestrator.unsubscribe(subId);
              resolve({ reply: text, ...(atts !== undefined ? { attachments: atts } : {}) });
            });
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
        resolve(null);
      }, timeout);
    });

    if (reply) return reply;

    return {
      stillWorking: true,
      followUp: 'Please call wait_for_reply again shortly.',
      status: { message: 'The other agent is still preparing a response.' },
    };
  }
}
