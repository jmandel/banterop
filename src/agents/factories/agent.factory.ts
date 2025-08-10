// src/agents/factories/agent.factory.ts
//
// Unified agent factory - transport-agnostic agent instantiation and management
// This replaces both startInternalAgents and startScenarioAgents with a single unified API

import type { IAgentTransport } from '$src/agents/runtime/runtime.interfaces';
import type { LLMProviderManager } from '$src/llm/provider-manager';
import type { AgentMeta } from '$src/types/conversation.meta';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import type { LLMProvider } from '$src/types/llm.types';

import { BaseAgent, type TurnRecoveryMode } from '$src/agents/runtime/base-agent';
import { AssistantAgent } from '$src/agents/assistant.agent';
import { EchoAgent } from '$src/agents/echo.agent';
import { ScenarioDrivenAgent } from '$src/agents/scenario/scenario-driven.agent';
import { ScriptAgent } from '$src/agents/script/script.agent';
import type { TurnBasedScript } from '$src/agents/script/script.types';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import { logLine } from '$src/lib/utils/logger';

export interface StartAgentsOptions {
  conversationId: number;
  transport: IAgentTransport;
  providerManager: LLMProviderManager;
  agentIds?: string[];  // Optional filter for which agents to start
  turnRecoveryMode?: TurnRecoveryMode;  // Optional override for all agents
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
  // Try both runtimeMeta (hydrated) and metadata (regular snapshot)
  const runtimeAgents: AgentMeta[] = hydrated?.runtimeMeta?.agents || hydrated?.metadata?.agents || [];

  // Filter to requested agents
  const candidates = agentIds?.length
    ? runtimeAgents.filter(a => agentIds.includes(a.id))
    : runtimeAgents;

  console.log(`[startAgents] Starting ${candidates.length} agents for conversation ${conversationId}`);
  console.log(`[startAgents] Runtime agents:`, runtimeAgents.map(a => ({ id: a.id, class: a.agentClass })));
  console.log(`[startAgents] Candidates:`, candidates.map(a => ({ id: a.id, class: a.agentClass })));

  for (const agentMeta of candidates) {
    // No filtering by kind - location is a runtime decision
    const agentId = agentMeta.id;
    console.log(`[startAgents] Creating agent ${agentId} with class ${agentMeta.agentClass || 'default'}`);

    // Create the agent with appropriate implementation
    const agent = createAgent(agentMeta, transport, providerManager, conversationId, scenario, options.turnRecoveryMode);
    
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
  providerManager: LLMProviderManager,
  conversationId: number,
  scenario?: ScenarioConfiguration | null,
  turnRecoveryModeOverride?: TurnRecoveryMode
): BaseAgent {
  const agentClass = (agentMeta.agentClass || 'default').toLowerCase();
  
  // Determine default recovery mode based on agent class
  let defaultRecoveryMode: TurnRecoveryMode = 'resume';
  if (agentClass === 'scenariodrivenagent' || agentClass === 'scenario') {
    defaultRecoveryMode = 'restart';  // Scenario agents should restart for consistency
  }
  
  // Use override if provided, otherwise use default for agent type
  const turnRecoveryMode = turnRecoveryModeOverride ?? 
    (agentMeta.config?.turnRecoveryMode as TurnRecoveryMode) ?? 
    defaultRecoveryMode;
  
  logLine(agentMeta.id, 'factory', `Creating ${agentClass} with recovery mode: ${typeof turnRecoveryMode === 'function' ? 'custom' : turnRecoveryMode}`);
  
  // Map agentClass to implementation (agents now create their own event streams)
  switch (agentClass) {
    case 'echoagent':
      return new EchoAgent(transport, 'Processing...', 'Done', { turnRecoveryMode });
    
    case 'assistantagent': {
      const provider = selectProvider(providerManager, agentMeta.config);
      return new AssistantAgent(transport, provider, { turnRecoveryMode });
    }
    
    case 'script':
      // Script agent needs script data from config
      const script = agentMeta.config?.script as TurnBasedScript | undefined;
      if (!script) {
        logLine(agentMeta.id, 'factory', `No script provided for script agent ${agentMeta.id}, falling back to AssistantAgent`);
        const provider = selectProvider(providerManager, agentMeta.config);
        return new AssistantAgent(transport, provider, { turnRecoveryMode });
      }
      logLine(agentMeta.id, 'factory', `Creating ScriptAgent with ${script.turns?.length || 0} turns`);
      return new ScriptAgent(transport, script, { turnRecoveryMode });
    
    case 'scenariodrivenagent':
    case 'scenario':
    case 'default':
      // Try ScenarioDrivenAgent if we have a scenario with this agent
      if (scenario?.agents.some(a => a.agentId === agentMeta.id)) {
        return new ScenarioDrivenAgent(transport, {
          agentId: agentMeta.id,
          providerManager,
          turnRecoveryMode  // Pass recovery mode to scenario agent
        });
      }
      // Fall back to AssistantAgent
      logLine(agentMeta.id, 'factory', `No scenario role for ${agentMeta.id}, using AssistantAgent`);
      {
        const provider = selectProvider(providerManager, agentMeta.config);
        return new AssistantAgent(transport, provider, { turnRecoveryMode });
      }
    
    default:
      // Unknown agent class, default to AssistantAgent
      logLine(agentMeta.id, 'factory', `Unknown agentClass '${agentClass}', using AssistantAgent`);
      {
        const provider = selectProvider(providerManager, agentMeta.config);
        return new AssistantAgent(transport, provider, { turnRecoveryMode });
      }
  }
}

/**
 * Helper to select LLM provider based on agent config
 */
function selectProvider(providerManager: LLMProviderManager, config?: Record<string, unknown>): LLMProvider {
  // Agent configs can suggest a model; provider selection is owned by the host
  const model = config?.model as string | undefined;
  return providerManager.getProvider({ ...(model ? { model } : {}) });
}
