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
import { InternalTurnLoop } from '$src/agents/executors/internal-turn-loop';
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
): Promise<{ loops: InternalTurnLoop[]; stop: () => Promise<void> }> {
  const loops: InternalTurnLoop[] = [];
  const logger = opts.logger;

  // Hydrated snapshot -> scenario for ScenarioDrivenAgent fallback
  const hydrated = orchestrator.getHydratedConversationSnapshot(conversationId);
  const scenario = hydrated?.scenario ?? null;

  for (const agent of meta.agents) {
    if (agent.kind !== 'internal') continue;

    const agentId = agent.id;
    const agentClass = (agent.agentClass || 'ScenarioDrivenAgent').toLowerCase();

    // Provider selection per agent (config override) or global default
    const provider = pickProvider(opts.providerManager, agent.config);

    // Instantiate agent implementation
    let impl:
      | AssistantAgent
      | EchoAgent
      | ScenarioDrivenAgent;

    if (agentClass === 'assistantagent') {
      impl = new AssistantAgent(provider);
    } else if (agentClass === 'echoagent') {
      impl = new EchoAgent('Processing...', 'Done');
    } else {
      // Default: ScenarioDrivenAgent (requires scenario + scenario role match)
      if (!scenario) {
        // If no scenario is present, fall back to AssistantAgent
        impl = new AssistantAgent(provider);
      } else {
        const myAgent = scenario.agents.find(a => a.agentId === agentId);
        if (!myAgent) {
          // If scenario lacks this agent role, fall back to AssistantAgent
          impl = new AssistantAgent(provider);
        } else {
          impl = new ScenarioDrivenAgent({
            agentId,
            providerManager: opts.providerManager,
          });
        }
      }
    }

    const loop = new InternalTurnLoop(impl, orchestrator, { 
      conversationId, 
      agentId, 
      ...(logger !== undefined ? { logger } : {})
    });
    void loop.start();
    loops.push(loop);
  }

  return {
    loops,
    stop: async () => {
      for (const l of loops) l.stop();
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