// src/agents/factories/internal-agent.factory.ts
//
// Start internal agents based on ConversationMeta.agents (AgentMeta[]).
// Supports simple agentClass routing: ScenarioDrivenAgent (default), AssistantAgent, EchoAgent.
// Falls back to ScenarioDrivenAgent when agentClass is missing or unrecognized.
// Per-agent LLM provider selection is supported through AgentMeta.config (provider/model/apiKey).
//

import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { ProviderManager } from '$src/llm/provider-manager';
import type { Logger } from '$src/agents/agent.types';
import type { ConvConversationMeta } from '$src/server/bridge/conv-config.types';
import { BaseAgent } from '$src/agents/runtime/base-agent';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import { InProcessEvents } from '$src/agents/runtime/inprocess.events';
import { AssistantAgent } from '$src/agents/assistant.agent';
import { EchoAgent } from '$src/agents/echo.agent';
import { ScenarioDrivenAgent } from '$src/agents/scenario/scenario-driven.agent';
import type { SupportedProvider, LLMProvider } from '$src/types/llm.types';

export interface StartInternalAgentsOptions {
  providerManager: ProviderManager;
  logger?: Logger;
}

/**
 * Start internal agents for a conversation, according to agentClass and scenario availability.
 * Returns a stop() to terminate all loops.
 */
export async function startInternalAgentsFromMeta(
  orchestrator: OrchestratorService,
  conversationId: number,
  meta: ConvConversationMeta,
  opts: StartInternalAgentsOptions
): Promise<{ agents: BaseAgent[]; stop: () => Promise<void> }> {
  const agents: BaseAgent[] = [];

  // Hydrated snapshot -> scenario for ScenarioDrivenAgent fallback
  const hydrated = orchestrator.getHydratedConversationSnapshot(conversationId);
  const scenario = hydrated?.scenario ?? null;

  for (const agent of meta.agents) {
    if (agent.kind !== 'internal') continue;

    const agentId = agent.id;
    const agentClass = (agent.agentClass || 'ScenarioDrivenAgent').toLowerCase();

    // Validate: agentId must exist in scenario for Connectathon strictness
    if (scenario) {
      const inScenario = scenario.agents.some(sa => sa.agentId === agentId);
      if (!inScenario) {
        throw new Error(
          `Config error: runtime agent "${agentId}" not found in scenario "${scenario.metadata.id}"`
        );
      }
    }

    // Provider selection per agent (config override) or global default
    const provider = pickProvider(opts.providerManager, agent.config);

    // Create transport and events for this agent
    const transport = new InProcessTransport(orchestrator);
    const events = new InProcessEvents(orchestrator, conversationId, true);

    // Instantiate agent implementation
    let impl: BaseAgent;

    if (agentClass === 'assistantagent') {
      impl = new AssistantAgent(transport, events, provider);
    } else if (agentClass === 'echoagent') {
      impl = new EchoAgent(transport, events, 'Processing...', 'Done');
    } else {
      // Default: ScenarioDrivenAgent (requires scenario + scenario role match)
      if (!scenario) {
        // If no scenario is present, fall back to AssistantAgent
        impl = new AssistantAgent(transport, events, provider);
      } else {
        const myAgent = scenario.agents.find(a => a.agentId === agentId);
        if (!myAgent) {
          // If scenario lacks this agent role, fall back to AssistantAgent
          impl = new AssistantAgent(transport, events, provider);
        } else {
          impl = new ScenarioDrivenAgent(transport, events, {
            agentId,
            providerManager: opts.providerManager,
          });
        }
      }
    }

    // Start the agent
    await impl.start(conversationId, agentId);
    agents.push(impl);
  }

  return {
    agents,
    stop: async () => {
      for (const a of agents) a.stop();
    },
  };
}

function pickProvider(pm: ProviderManager, cfg?: Record<string, unknown>): LLMProvider {
  // Read a minimal set of keys commonly used to choose provider/model/apiKey
  // Support both 'llmProvider' and 'provider' for backward compatibility
  const provider = ((cfg?.llmProvider ?? cfg?.provider) as SupportedProvider | undefined);
  const model = (cfg?.model as string | undefined);
  const apiKey = (cfg?.apiKey as string | undefined);

  // ProviderManager.getProvider will throw if non-mock provider has no key in config and none provided
  return pm.getProvider({
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(apiKey ? { apiKey } : {}),
  });
}