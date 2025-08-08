import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { ProviderManager } from '$src/llm/provider-manager';
import type { Logger } from '$src/agents/agent.types';
import type { AgentMeta } from '$src/types/conversation.meta';
import { ScenarioDrivenAgent } from '$src/agents/scenario/scenario-driven.agent';
import { BaseAgent } from '$src/agents/runtime/base-agent';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import { InProcessEvents } from '$src/agents/runtime/inprocess.events';

export interface StartScenarioAgentsOptions {
  providerManager: ProviderManager;      // Provider manager for LLM access
  agentIds?: string[];                   // Explicit agent IDs to run internally (optional)
  logger?: Logger;                        // Optional shared logger
  maxStepsPerTurn?: number;              // Reserved for future extensions
  useOracle?: boolean;                   // Reserved for future extensions
}

export interface ScenarioAgentHandle {
  agents: BaseAgent[];
  stop: () => Promise<void>;
}

/**
 * Start one or more scenario-driven internal agents for a conversation.
 * Returns handles to stop all loops.
 */
export async function startScenarioAgents(
  orchestrator: OrchestratorService,
  conversationId: number,
  options: StartScenarioAgentsOptions
): Promise<ScenarioAgentHandle> {
  const { providerManager, agentIds } = options;

  const hydrated = orchestrator.getHydratedConversationSnapshot(conversationId);
  if (!hydrated || !hydrated.scenario) {
    throw new Error(`Conversation ${conversationId} is not hydrated with a scenario`);
  }

  const scenario = hydrated.scenario;
  const runtimeAgents: AgentMeta[] = hydrated.runtimeMeta?.agents || [];

  // Determine which agent IDs to run internally
  let idsToRun: string[] = [];
  
  if (agentIds?.length) {
    // Explicit agent IDs provided
    idsToRun = agentIds;
  } else if (runtimeAgents.length > 0) {
    // Use runtime configuration to determine internal agents
    idsToRun = runtimeAgents
      .filter(a => a.kind === 'internal')
      .map(a => a.id);
  }
  
  if (idsToRun.length === 0) {
    // No agents to run
    return {
      agents: [],
      stop: async () => {},
    };
  }

  const agents: BaseAgent[] = [];

  for (const agentId of idsToRun) {
    // Verify strict match with scenario
    const scenarioAgent = scenario.agents.find(a => a.agentId === agentId);
    if (!scenarioAgent) {
      throw new Error(
        `Config error: runtime agent "${agentId}" not found in scenario "${scenario.metadata.id}"`
      );
    }

    // Create transport and events for this agent
    const transport = new InProcessTransport(orchestrator);
    const events = new InProcessEvents(orchestrator, conversationId, true);

    // Create the scenario-driven agent implementation
    const agentImpl = new ScenarioDrivenAgent(transport, events, {
      agentId,
      providerManager,
      options: {
        agentId,
      },
    });

    // Start the agent
    void agentImpl.start(conversationId, agentId).catch(err => {
      console.error(`Error in scenario agent for ${agentId}:`, err);
    });
    
    agents.push(agentImpl);
  }

  return {
    agents,
    stop: async () => {
      // Stop all agents
      for (const agent of agents) {
        agent.stop();
      }
      // Give them a moment to clean up
      await new Promise(resolve => setTimeout(resolve, 100));
    },
  };
}

/**
 * Helper to create a conversation with scenario-driven agents
 */
export async function createScenarioConversation(
  orchestrator: OrchestratorService,
  providerManager: ProviderManager,
  options: {
    scenarioId: string;
    title?: string;
    agents: Array<{
      id: string;
      kind: 'internal' | 'external';
      agentClass?: string;
      config?: Record<string, unknown>;
    }>;
    startingAgentId?: string;
    custom?: Record<string, unknown>;
  }
): Promise<{ conversationId: number; handle: ScenarioAgentHandle }> {
  // Create the conversation
  const conversationId = orchestrator.createConversation({
    scenarioId: options.scenarioId,
    ...(options.title !== undefined ? { title: options.title } : {}),
    agents: options.agents,
    ...(options.startingAgentId !== undefined ? { startingAgentId: options.startingAgentId } : {}),
    ...(options.custom !== undefined ? { custom: options.custom } : {}),
  });
  
  // Start internal agents
  const internalAgentIds = options.agents
    .filter(a => a.kind === 'internal')
    .map(a => a.id);
  
  const handle = await startScenarioAgents(orchestrator, conversationId, {
    providerManager,
    agentIds: internalAgentIds,
  });
  
  return { conversationId, handle };
}