import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { ProviderManager } from '$src/llm/provider-manager';
import type { Logger } from '$src/agents/agent.types';
import type { AgentMeta } from '$src/types/conversation.meta';
import { ScenarioDrivenAgent } from '$src/agents/scenario/scenario-driven.agent';
import { TurnLoopExecutorInternal } from '$src/agents/executors/turn-loop-executor.internal';

export interface StartScenarioAgentsOptions {
  providerManager: ProviderManager;      // Provider manager for LLM access
  agentIds?: string[];                   // Explicit agent IDs to run internally (optional)
  logger?: Logger;                        // Optional shared logger
  maxStepsPerTurn?: number;              // Reserved for future extensions
  useOracle?: boolean;                   // Reserved for future extensions
}

export interface ScenarioAgentHandle {
  loops: TurnLoopExecutorInternal[];
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
  const { providerManager, agentIds, logger, maxStepsPerTurn, useOracle } = options;

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
      loops: [],
      stop: async () => {},
    };
  }

  const loops: TurnLoopExecutorInternal[] = [];

  for (const agentId of idsToRun) {
    // Verify strict match with scenario
    const scenarioAgent = scenario.agents.find(a => a.agentId === agentId);
    if (!scenarioAgent) {
      throw new Error(
        `Config error: runtime agent "${agentId}" not found in scenario "${scenario.metadata.id}"`
      );
    }

    // Create the scenario-driven agent implementation
    const agentImpl = new ScenarioDrivenAgent({
      agentId,
      providerManager,
      options: {
        agentId,
        ...(maxStepsPerTurn !== undefined ? { maxStepsPerTurn } : {}),
        ...(useOracle !== undefined ? { useOracle } : {}),
      },
    });

    // Create the internal turn loop executor
    const loop = new TurnLoopExecutorInternal(orchestrator, {
      conversationId,
      agentId,
      meta: { id: agentId, kind: 'internal' },  // Minimal metadata for backward compatibility
      buildAgent: () => agentImpl,  // For backward compatibility, wrap the pre-built agent
      ...(logger !== undefined ? { logger } : {}),
    });

    // Start the loop (fire and forget)
    void loop.start().catch(err => {
      console.error(`Error in scenario agent loop for ${agentId}:`, err);
    });
    
    loops.push(loop);
  }

  return {
    loops,
    stop: async () => {
      // Stop all loops
      for (const loop of loops) {
        loop.stop();
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