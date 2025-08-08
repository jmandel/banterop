// src/agents/factories/internal-agent.factory.ts
//
// Backward compatibility wrapper - redirects to unified factory

import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { ProviderManager } from '$src/llm/provider-manager';
import { startAgents, type AgentHandle } from './agent.factory';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';

export interface StartInternalAgentsOptions {
  providerManager: ProviderManager;
  logger?: any; // unused, for backward compat
  agentIds?: string[];
}

/**
 * Backward compatibility wrapper - use startAgents() instead
 */
export async function startInternalAgents(
  orchestrator: OrchestratorService,
  conversationId: number,
  opts: StartInternalAgentsOptions
): Promise<AgentHandle> {
  return startAgents({
    conversationId,
    transport: new InProcessTransport(orchestrator),
    providerManager: opts.providerManager,
    ...(opts.agentIds ? { agentIds: opts.agentIds } : {})
  });
}

// Re-export other functions that might be used
export { createAgent as createAgentForMeta } from './agent.factory';
export { createAgent as createAgentAgnostic } from './agent.factory';