// src/agents/factories/agent.factory.ts
//
// Unified agent factory - transport-agnostic agent instantiation and management
// This replaces both startInternalAgents and startScenarioAgents with a single unified API

import type { IAgentTransport } from '$src/agents/runtime/runtime.interfaces';
import type { ProviderManager } from '$src/llm/provider-manager';
import type { AgentMeta } from '$src/types/conversation.meta';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import type { LLMProvider } from '$src/types/llm.types';

import { BaseAgent } from '$src/agents/runtime/base-agent';
import { AssistantAgent } from '$src/agents/assistant.agent';
import { EchoAgent } from '$src/agents/echo.agent';
import { ScenarioDrivenAgent } from '$src/agents/scenario/scenario-driven.agent';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import { logLine } from '$src/lib/utils/logger';

export interface StartAgentsOptions {
  conversationId: number;
  transport: IAgentTransport;
  providerManager: ProviderManager;
  agentIds?: string[];  // Optional filter for which agents to start
}

export interface AgentHandle {
  agents: BaseAgent[];
  stop(): Promise<void>;
}

/**
 * Unified agent starter - works with any transport (InProcess, WebSocket, etc)
 * This is the single entry point for starting agents, regardless of execution location.
 */
export async function startAgents(options: StartAgentsOptions): Promise<AgentHandle> {
  const { conversationId, transport, providerManager, agentIds } = options;
  const agents: BaseAgent[] = [];

  // Get conversation metadata and scenario
  const snapshot = await transport.getSnapshot(conversationId, { includeScenario: true });
  const hydrated = snapshot as any; // Type assertion for hydrated snapshot
  const scenario = hydrated?.scenario ?? null;
  const runtimeAgents: AgentMeta[] = hydrated?.runtimeMeta?.agents || [];

  // Filter to requested agents
  const candidates = agentIds?.length
    ? runtimeAgents.filter(a => agentIds.includes(a.id))
    : runtimeAgents;

  console.log(`[startAgents] Starting ${candidates.length} agents for conversation ${conversationId}`);

  for (const agentMeta of candidates) {
    // Skip external agents if we're filtering by kind
    // (In the unified model, "internal" vs "external" is determined by transport, not metadata)
    if (agentMeta.kind === 'external' && transport instanceof InProcessTransport) {
      console.log(`[startAgents] Skipping ${agentMeta.id} - marked as external but using InProcessTransport`);
      continue;
    }

    const agentId = agentMeta.id;
    console.log(`[startAgents] Creating agent ${agentId} with class ${agentMeta.agentClass || 'default'}`);

    // Create the agent with appropriate implementation
    const agent = createAgent(agentMeta, transport, providerManager, conversationId, scenario);
    
    // Start the agent
    await agent.start(conversationId, agentId);
    agents.push(agent);
  }

  return {
    agents,
    stop: async () => {
      console.log(`[startAgents] Stopping ${agents.length} agents`);
      for (const agent of agents) {
        agent.stop();
      }
      // Give agents time to clean up
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
}

/**
 * Low-level factory for creating a single agent instance
 * Transport-agnostic: works with any IAgentTransport implementation
 */
export function createAgent(
  agentMeta: AgentMeta,
  transport: IAgentTransport,
  providerManager: ProviderManager,
  conversationId: number,
  scenario?: ScenarioConfiguration | null
): BaseAgent {
  const agentClass = (agentMeta.agentClass || 'default').toLowerCase();
  const provider = selectProvider(providerManager, agentMeta.config);

  // Create event stream from transport
  const events = transport.createEventStream(conversationId, true);
  
  // Map agentClass to implementation (using existing constructors for now)
  switch (agentClass) {
    case 'echoagent':
      return new EchoAgent(transport, events, 'Processing...', 'Done');
    
    case 'assistantagent':
      return new AssistantAgent(transport, events, provider);
    
    case 'scenariodrivenagent':
    case 'default':
      // Try ScenarioDrivenAgent if we have a scenario with this agent
      if (scenario?.agents.some(a => a.agentId === agentMeta.id)) {
        return new ScenarioDrivenAgent(transport, events, {
          agentId: agentMeta.id,
          providerManager
        });
      }
      // Fall back to AssistantAgent
      logLine(agentMeta.id, 'factory', `No scenario role for ${agentMeta.id}, using AssistantAgent`);
      return new AssistantAgent(transport, events, provider);
    
    default:
      // Unknown agent class, default to AssistantAgent
      logLine(agentMeta.id, 'factory', `Unknown agentClass '${agentClass}', using AssistantAgent`);
      return new AssistantAgent(transport, events, provider);
  }
}

/**
 * Helper to select LLM provider based on agent config
 */
function selectProvider(providerManager: ProviderManager, config?: Record<string, unknown>): LLMProvider {
  // Support both 'llmProvider' and 'provider' for backward compatibility
  const provider = (config?.llmProvider ?? config?.provider) as string | undefined;
  const model = config?.model as string | undefined;
  const apiKey = config?.apiKey as string | undefined;

  return providerManager.getProvider({
    ...(provider ? { provider: provider as any } : {}),
    ...(model ? { model } : {}),
    ...(apiKey ? { apiKey } : {})
  });
}

