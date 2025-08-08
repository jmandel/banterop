Here’s a self-contained development plan to add (1) scenario‑driven internal agents and (2) an MCP bridge for simple MCP clients to participate alongside a simulation agent, adapted to your v3 stack and your latest ScenarioConfiguration schema.

Objectives
- Scenario-driven internal agents
  - Run one or more in-process agents whose behavior is driven by a ScenarioConfiguration (persona, goals, tools, knowledgeBase).
  - Agents alternate turns using existing guidance + claim mechanics.
  - Support one-LLM-step (message-only) initially; optionally support thought/tool_call/tool_result traces and document attachments via an “Oracle” tool synthesis service.
- MCP bridge
  - Expose a stateless MCP endpoint that registers three tools:
    - begin_chat_thread(): Create a conversation from a base64 config, stand up the internal scenario‑driven counterparty, return conversationId.
    - send_message_to_chat_thread(): Post a turn as the MCP-side agent; wait for the counterparty reply with a timeout; return reply or “stillWorking”.
    - wait_for_reply(): Poll-for-reply variant without sending a new message.
  - Works with v3 orchestrator. No persistence required in the bridge itself.

Deliverables (high-level)
- New agent: ScenarioDrivenAgent (internal) using your ScenarioConfiguration (final schema you pasted).
- Optional Oracle: ToolSynthesisService to synthesize tool results and attach docs.
- MCP bridge server and Hono route wiring (/bridge/:config64/mcp).
- Factory/helper to spin up internal agents from a scenario.
- Tests for both features (unit + integration).
- Config additions (timeouts; optional policy selection).

Dependencies
- @modelcontextprotocol/sdk (MCP)
- zod (already used)
- No DB migration required (ScenarioStore stores JSON; schema-agnostic)

Data model and types

A. Scenario configuration (adopt the “final” schema you shared)
- Create src/types/scenario.v3.types.ts (coexists with current scenario-configuration.types)
  - ScenarioConfiguration:
    - metadata: { id: string; title: string; description: string; tags?: string[] }
    - scenario: { background: string; challenges: string[]; interactionNotes?: Record<string, unknown> }
    - agents: AgentConfiguration[]
  - AgentConfiguration:
    - agentId: string
    - principal: { type: 'individual' | 'organization'; name: string; description: string }
    - situation: string
    - systemPrompt: string
    - goals: string[]
    - tools: Tool[]
    - knowledgeBase: Record<string, unknown>
    - messageToUseWhenInitiatingConversation?: string
  - Tool:
    - toolName: string
    - description: string
    - inputSchema: { type: 'object'; properties?: Record<string, any>; required?: string[] }
    - synthesisGuidance: string
    - endsConversation?: boolean
    - conversationEndStatus?: 'success' | 'failure' | 'neutral'
- Wire ScenarioStore to accept/store this shape unchanged (no code change; it already stores JSON).
- Keep existing scenario-configuration.types.ts for backward-compat; prefer the v3 file in new code.

B. Scenario-driven agent interfaces (new)
- src/agents/scenario/scenario-driven.types.ts
  - ScenarioDrivenAgentOptions:
    - scenarioId: string
    - agentId: string
    - maxStepsPerTurn?: number (default: 1 for one-step MVP)
    - useOracle?: boolean (default: false)
  - ToolCall (internal runtime helper): { name: string; args?: Record<string, unknown> }
  - OracleResult: { reasoning: string; output: unknown }

C. MCP bridge types (new)
- src/server/bridge/mcp.types.ts
  - McpConfig (decoded from base64):
    - metadata: { scenarioId: string; conversationTitle?: string }
    - agents: Array<{ id: string; kind?: 'internal' | 'external' }>
    - bridgedAgentId?: string (optional; if missing, infer the external one)
  - BridgeReply:
    - reply: string
    - attachments?: Array<{ name: string; contentType: string; content: string }>
  - BridgeStatus:
    - stillWorking: true
    - followUp: string
    - status: { message: string; actionCount?: number; lastActionAt?: string; lastActionType?: string }

New modules and files

1) Scenario-driven agent (internal)
- File: src/agents/scenario/scenario-driven.agent.ts
- Exports: class ScenarioDrivenAgent implements Agent
- Constructor:
  - (opts: ScenarioDrivenAgentOptions, provider: LLMProvider)
- handleTurn(ctx: AgentContext): Promise<void>
  - Load hydrated snapshot: orchestrator.getHydratedConversationSnapshot(ctx.conversationId)
  - Resolve my AgentConfiguration by agentId
  - Build prompt from:
    - systemPrompt, situation, goals
    - Lightweight conversation history (message events; optionally trace summaries)
  - Call provider.complete({ messages })
  - Option A (MVP): Post one message: ctx.client.postMessage({ text: response.content, finality: 'turn' })
  - Option B (optional later): Stream trace thought + tool_call + tool_result via ctx.client.postTrace, call Oracle to synthesize tool results and attach docs (see ToolSynthesisService), then finalize message.
- Helpers:
  - buildMessagesFromHistory(snapshot): LLMMessage[]
  - maybeAddTracesAndAttachments(...)

2) Optional Oracle for tool synthesis (re-adding v2 idea)
- File: src/agents/services/tool-synthesis.service.ts
- Exports: class ToolSynthesisService
- execute(input):
  - toolName, args, agentId, scenario (ScenarioConfiguration), conversationHistory (string)
  - Build “oracle” prompt using tool.synthesisGuidance, calling agent persona, and global scenario context
  - provider.complete; parse a JSON code block with { reasoning, output }
  - Return { output }
- Will be used only if ScenarioDrivenAgentOptions.useOracle is true; otherwise skip.

3) Internal agent factory
- File: src/agents/factories/scenario-agent.factory.ts
- Exports:
  - startScenarioAgents(orchestrator, conversationId, agentIds?: string[]): { stop(): Promise<void> }
    - Loads hydrated snapshot
    - Identify internal agent IDs: if agentIds provided, use those; else infer from runtime metadata (ConversationMeta.agents with kind='internal') or from scenario config (fallback)
    - For each, create ScenarioDrivenAgent and InternalTurnLoop; start; return a handle that can stop them all

4) MCP bridge server and adapters
- File: src/server/bridge/hono-node-adapters.ts
  - HonoIncomingMessage: converts Hono context to a Node-style IncomingMessage stream
  - HonoServerResponse: buffered/Hono streaming response; supports JSON responses
- File: src/server/bridge/mcp-server.ts
  - Imports: McpServer, StreamableHTTPServerTransport
  - Constructor(orchestrator: OrchestratorService, scenarioId: string, config64: string, sessionId: string)
  - getMcpServer(): McpServer
  - handleRequest(req, res, body): Promise<void>
    - Decode config64 (McpConfig) and validate with zod; find bridged agent
    - Load scenario (from ScenarioStore) for contextual descriptions
    - Register tools with dynamic descriptions from scenario:
      - begin_chat_thread(): create conversation, start internal counterparty loop; return { conversationId }
      - send_message_to_chat_thread({ conversationId, message, attachments? }):
        - orchestrator.sendMessage(conversationId, bridgedAgentId, { text, attachments }, 'turn')
        - Wait for counterparty’s message via in-process subscription (see Wait algorithm below)
      - wait_for_reply({ conversationId }):
        - Same wait without sending a message
- File: src/server/routes/bridge.mcp.ts
  - createBridgeRoutes(orchestrator: OrchestratorService)
  - Routes:
    - ALL /bridge/:config64/mcp -> use adapters + McpBridgeServer.handleRequest
    - GET /bridge/:config64/mcp/diag -> decode config64, return parsed/validated introspection

5) Config updates
- File: src/server/config.ts
  - Add bridgeReplyTimeoutMs?: number (default: 15000)
  - Optional: policy selection (e.g., use ScenarioPolicy instead of SimpleAlternationPolicy)
- File: src/server/app.ts
  - Pass policy override if desired (new ScenarioPolicy())
  - Expose providerManager to ScenarioDrivenAgent instantiation (agents will receive a provider instance)

6) Server wiring
- File: src/server/index.ts
  - Mount bridge routes: server.route('/bridge', createBridgeRoutes(appInstance.orchestrator))

Algorithms and flows

A. Scenario-driven internal loop (per turn)
- Trigger: orchestrator emits guidance with nextAgentId = me
- Loop claims turn via orchestrator.claimTurn; if ok:
  - Snapshot = ctx.client.getSnapshot(conversationId)
  - scenario = orchestrator.getHydratedConversationSnapshot(conversationId)?.scenario
  - myRole = scenario.agents.find(a => a.agentId === ctx.agentId)
  - Build messages: [system from myRole.systemPrompt, history as user/assistant pairs]
  - LLM complete; send one message (finality='turn')
- Optional extended mode:
  - Post one or more traces (thought/tool_call)
  - For tool_call, call ToolSynthesisService to get tool_result (Doc-typed outputs with docId)
  - Create attachments (by docId content) on final message

B. MCP bridge “wait for reply”
- After posting a bridged agent message:
  - Subscribe to orchestrator SubscriptionBus with { conversation }
  - Record seq at time of post (from appendEvent result if using in-process; via Snapshot polling otherwise)
  - Wait up to bridgeReplyTimeoutMs for the first UnifiedEvent of type=message where agentId != bridgedAgentId and seq > startSeq
  - If found:
    - Build BridgeReply { reply: payload.text, attachments: fetch content by id }
  - Else return BridgeStatus stillWorking with a friendly status string

Public HTTP/MCP contract (stateless)
- Endpoint: /bridge/:config64/mcp
- tools/list: returns three tools: begin_chat_thread, send_message_to_chat_thread, wait_for_reply
- tools/call begin_chat_thread -> returns { content: [{ type: 'text', text: '{"conversationId": <number>}' }] }
- tools/call send_message_to_chat_thread -> returns:
  - On reply: { content: [{ type: 'text', text: '{"reply":"...", "attachments":[...]}' }] }
  - On timeout: { content: [{ type: 'text', text: '{"stillWorking": true, "followUp": "...", "status": {...}}' }] }
- tools/call wait_for_reply -> same reply/timeout behavior

Validation (zod)
- McpConfig:
  - metadata.scenarioId required
  - agents: array length >= 1; at least one bridged agent must be identifiable:
    - bridgedAgentId OR agents contains one with kind='external'
  - If two agents present and one is internal, we’ll start an internal loop for that one

Configuration
- Add to Config schema:
  - bridgeReplyTimeoutMs: number default 15000
  - defaultLlmProvider remains; internal agents retrieve a provider via App.providerManager.getProvider()
  - Optional: orchestratorPolicy: 'simple' | 'scenario' (use ScenarioPolicy if 'scenario')

Key signatures (concise)

ScenarioDrivenAgent
- constructor(options: ScenarioDrivenAgentOptions, provider: LLMProvider)
- handleTurn(ctx: AgentContext): Promise<void>

ToolSynthesisService (optional)
- constructor(provider: LLMProvider)
- execute(input: { toolName; args; agentId; scenario; conversationHistory }): Promise<{ output: unknown }>

Factory
- startScenarioAgents(orchestrator, conversationId, agentIds?): { stop(): Promise<void> }

MCP bridge
- new McpBridgeServer(orchestrator, scenarioId, config64, sessionId)
- getMcpServer(): McpServer
- handleRequest(req, res, body): Promise<void>

Bridge utils
- decodeConfigFromBase64(config64): McpConfig
- determineBridgedAgentId(config): string
- determineInternalAgentIds(config): string[]

Tests

Scenario-driven agent tests
- Unit: Given scenario with two agents (both internal), start both internal loops. Send kickoff user message; verify alternation and that each agent posts at least one message.
- Unit: Agent picks up systemPrompt/goals correctly; posts a message with finality='turn'.
- Optional: Tool synthesis path produces a tool_result trace and attaches a document (docId) to the final message.

MCP bridge tests (adapt v2)
- tools/list returns three tools
- begin_chat_thread returns conversationId; conversation exists; internal counterparty loop started
- send_message_to_chat_thread with no counterparty reply within short timeout returns stillWorking JSON
- wait_for_reply before any reply returns stillWorking
- send unknown tool returns -32602 Tool not found
- Unknown method returns -32601
- Diag endpoint returns parsed config and basic info

Integration tests
- Bridge + real orchestrator:
  - Create scenario; call begin_chat_thread; call send_message...; spawn a ScenarioDrivenAgent loop for the counterparty that replies; verify the send returns the reply when it arrives.
- Attachments:
  - Send a message with attachments; verify attachments stored and payload rewritten; reply includes attachments if counterparty echoes/uses them.

Migration notes from v2
- Scenario schema: use your “final” v3 schema; ScenarioStore is schema-agnostic so no DB changes.
- Bridge: v2 unit tests used StreamableHTTPServerTransport with Node adapters; we port those adapters for Hono/Bun.
- The v3 orchestrator enforces finality and idempotency; ensure the bridge and scenario-driven agent always use finality='turn' or 'conversation' as appropriate.
- “Automatic resurrection” and complex internal agent lifecycle from v2 are not reintroduced; internal loops are started ad hoc via factory.

Timeline (phased)
- Week 1
  - Types: scenario.v3.types.ts; mcp.types.ts
  - ScenarioDrivenAgent MVP (one-step message)
  - Factory startScenarioAgents
  - ScenarioPolicy wiring (optional)
  - Unit tests for ScenarioDrivenAgent
- Week 2
  - MCP adapters + McpBridgeServer + routes
  - tools/list, begin_chat_thread, send_message_to_chat_thread, wait_for_reply
  - Integration tests for bridge
- Week 3 (optional)
  - ToolSynthesisService
  - Extended ScenarioDrivenAgent with traces/tool flow and attachments
  - Additional tests for tool synthesis and attachments
- Week 4 (hardening)
  - Docs, examples, smoke tests; timeouts and error handling polish

Open questions and defaults
- Which agent plays first? Default: user starts, or scenario-driven agent if messageToUseWhenInitiatingConversation is set and we explicitly kick it off (future: a “start” helper can send an initial message).
- Policy: Use ScenarioPolicy to choose nextAgentId from scenario; otherwise SimpleAlternationPolicy works if both agents participate.
- Authentication: Bridge endpoint currently unauthenticated; acceptable for connectathon lab; add reverse proxy auth if needed.

Summary of file additions
- src/types/scenario.v3.types.ts
- src/agents/scenario/scenario-driven.types.ts
- src/agents/scenario/scenario-driven.agent.ts
- src/agents/services/tool-synthesis.service.ts (optional)
- src/agents/factories/scenario-agent.factory.ts
- src/server/bridge/hono-node-adapters.ts
- src/server/bridge/mcp-server.ts
- src/server/bridge/mcp.types.ts
- src/server/routes/bridge.mcp.ts
- Config updates in src/server/config.ts and usage in src/server/app.ts
- Mount route in src/server/index.ts

With this plan, you get role-true scenario agents and a working MCP bridge on top of v3’s strong event/log/guidance core, while keeping changes localized and testable.


---

Here are the TypeScript files for Phase 1 (scenario-driven internal agents MVP). You can paste them directly into your repo.

File: src/types/scenario.v3.types.ts
---
export interface ScenarioConfiguration {
  metadata: {
    id: string;
    title: string;
    description: string;
    tags?: string[];
  };

  scenario: {
    background: string;
    challenges: string[];
    interactionNotes?: Record<string, unknown>;
  };

  agents: AgentConfiguration[];
}

export interface AgentConfiguration {
  agentId: string;

  principal: {
    type: 'individual' | 'organization';
    name: string;
    description: string;
  };

  situation: string;

  systemPrompt: string;

  goals: string[];

  tools: Tool[];

  knowledgeBase: Record<string, unknown>;

  messageToUseWhenInitiatingConversation?: string;
}

export interface Tool {
  toolName: string;
  description: string;
  inputSchema: { type: 'object'; properties?: Record<string, any>; required?: string[] };
  synthesisGuidance: string;
  endsConversation?: boolean;
  conversationEndStatus?: 'success' | 'failure' | 'neutral';
}


File: src/agents/scenario/scenario-driven.types.ts
---
import type { ScenarioConfiguration, AgentConfiguration } from '$src/types/scenario.v3.types';
import type { LLMProvider } from '$src/types/llm.types';

export interface ScenarioDrivenAgentOptions {
  scenario: ScenarioConfiguration;
  myAgent: AgentConfiguration;
  provider: LLMProvider;
  maxStepsPerTurn?: number; // reserved for future multi-step support
  useOracle?: boolean;      // reserved for future oracle/tool synthesis support
}


File: src/agents/scenario/scenario-driven.agent.ts
---
import type { Agent, AgentContext } from '$src/agents/agent.types';
import type { ScenarioConfiguration, AgentConfiguration } from '$src/types/scenario.v3.types';
import type { LLMMessage, LLMProvider } from '$src/types/llm.types';

export interface ScenarioDrivenAgentConfig {
  scenario: ScenarioConfiguration;
  myAgent: AgentConfiguration;
  provider: LLMProvider;
  maxStepsPerTurn?: number;
  useOracle?: boolean;
}

/**
 * Scenario-driven internal agent (MVP).
 * - Single-step: builds a prompt from scenario persona + conversation history
 * - Produces one assistant message with finality='turn'
 * - Future: optional traces/tool synthesis with Oracle
 */
export class ScenarioDrivenAgent implements Agent {
  private scenario: ScenarioConfiguration;
  private me: AgentConfiguration;
  private provider: LLMProvider;
  private maxSteps: number;
  private useOracle: boolean;

  constructor(cfg: ScenarioDrivenAgentConfig) {
    this.scenario = cfg.scenario;
    this.me = cfg.myAgent;
    this.provider = cfg.provider;
    this.maxSteps = cfg.maxStepsPerTurn ?? 1;
    this.useOracle = cfg.useOracle ?? false;
  }

  async handleTurn(ctx: AgentContext): Promise<void> {
    const { conversationId, agentId, client, logger } = ctx;

    // Build LLM messages from scenario persona and conversation history
    const history = await client.getSnapshot(conversationId);
    const messages = this.buildMessages(agentId, this.me, history.events);

    // Single-step completion
    const response = await this.provider.complete({ messages });

    const text = response.content?.trim() || '...';
    await client.postMessage({
      conversationId,
      agentId,
      text,
      finality: 'turn',
    });

    logger.info(`ScenarioDrivenAgent(${agentId}) posted a turn`);
  }

  private buildMessages(
    myAgentId: string,
    myAgent: AgentConfiguration,
    events: Array<{
      type: string;
      agentId: string;
      payload: any;
    }>
  ): LLMMessage[] {
    // System prompt synthesizes persona + situation + goals
    const systemParts: string[] = [];
    systemParts.push(`You are an AI agent participating in a scenario-driven conversation.`);
    systemParts.push(`Role: ${myAgent.agentId}`);
    systemParts.push(`Principal: ${myAgent.principal.name} — ${myAgent.principal.description}`);
    systemParts.push(`Situation: ${myAgent.situation}`);
    systemParts.push(`Persona/Instructions: ${myAgent.systemPrompt}`);
    if (myAgent.goals?.length) {
      systemParts.push(`Goals:\n${myAgent.goals.map((g) => `- ${g}`).join('\n')}`);
    }
    // Scenario meta (short)
    systemParts.push(`Scenario: ${this.scenario.metadata.title} — ${this.scenario.metadata.description}`);

    const messages: LLMMessage[] = [{ role: 'system', content: systemParts.join('\n') }];

    // Add conversation history as alternating user/assistant messages
    for (const e of events) {
      if (e.type !== 'message') continue;
      const text = (e.payload && typeof e.payload.text === 'string') ? e.payload.text : '';
      if (!text) continue;

      const role: 'user' | 'assistant' = e.agentId === myAgentId ? 'assistant' : 'user';
      messages.push({ role, content: text });
    }

    return messages;
  }
}


File: src/agents/factories/scenario-agent.factory.ts
---
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { LLMProvider } from '$src/types/llm.types';
import type { Logger } from '$src/agents/agent.types';
import type { ScenarioConfiguration, AgentConfiguration } from '$src/types/scenario.v3.types';
import { ScenarioDrivenAgent } from '$src/agents/scenario/scenario-driven.agent';
import { InternalTurnLoop } from '$src/agents/executors/internal-turn-loop';

export interface StartScenarioAgentsOptions {
  provider: LLMProvider;          // Required LLM provider for scenario-driven agents
  agentIds?: string[];            // Explicit agent IDs to run internally (optional)
  logger?: Logger;                // Optional shared logger
  maxStepsPerTurn?: number;       // Reserved for future extensions
  useOracle?: boolean;            // Reserved for future extensions
}

/**
 * Start one or more scenario-driven internal agents for a conversation.
 * Returns handles to stop all loops.
 */
export async function startScenarioAgents(
  orchestrator: OrchestratorService,
  conversationId: number,
  options: StartScenarioAgentsOptions
): Promise<{ loops: InternalTurnLoop[]; stop: () => Promise<void> }> {
  const { provider, agentIds, logger, maxStepsPerTurn, useOracle } = options;

  const hydrated = orchestrator.getHydratedConversationSnapshot(conversationId);
  if (!hydrated || !hydrated.scenario) {
    throw new Error(`Conversation ${conversationId} is not hydrated with a scenario`);
  }

  const scenario: ScenarioConfiguration = hydrated.scenario;
  const runtimeAgents: Array<{ id: string; kind?: 'internal' | 'external' }> =
    (hydrated.runtimeMeta?.agents as any[]) || [];

  // Determine which agent IDs to run
  let idsToRun: string[] = [];
  if (agentIds?.length) {
    idsToRun = agentIds;
  } else if (runtimeAgents.length > 0) {
    idsToRun = runtimeAgents.filter(a => a.kind === 'internal').map(a => a.id);
    if (idsToRun.length === 0) {
      // fallback: if none marked internal, run all scenario agents
      idsToRun = scenario.agents.map(a => a.agentId);
    }
  } else {
    // fallback to all scenario agents
    idsToRun = scenario.agents.map(a => a.agentId);
  }

  const loops: InternalTurnLoop[] = [];

  for (const agentId of idsToRun) {
    const myAgent = scenario.agents.find(a => a.agentId === agentId);
    if (!myAgent) {
      // Skip non-scenario participants
      continue;
    }

    const agentImpl = new ScenarioDrivenAgent({
      scenario,
      myAgent: myAgent as AgentConfiguration,
      provider,
      maxStepsPerTurn,
      useOracle,
    });

    const loop = new InternalTurnLoop(agentImpl, orchestrator, {
      conversationId,
      agentId,
      logger,
    });

    // Fire and forget start; caller can await stop() later
    void loop.start();
    loops.push(loop);
  }

  return {
    loops,
    stop: async () => {
      for (const l of loops) {
        l.stop();
      }
    },
  };
}
