// Agent helper utilities

import type { AgentConfig } from '$lib/types.js';

/**
 * Determines if an agent is server-managed (runs inside the backend process)
 * vs externally managed (connects via WebSocket or other external protocol)
 * 
 * Server-managed agents are lifecycle-managed by the orchestrator and include:
 * - scenario_driven: Agents driven by scenario configurations
 * - sequential_script: Agents following pre-defined scripts
 * - static_replay: Simple replay agents
 * - bridge_to_external_*: Bridge agents that translate between protocols
 * 
 * External agents (external_websocket_client) manage their own lifecycle
 * and connect to the orchestrator via WebSocket.
 */
export function isServerManaged(agent: AgentConfig): boolean {
  const serverManagedTypes = [
    'scenario_driven',
    'sequential_script',
    'static_replay',
    'simple_resumable',
    'bridge_to_external_mcp_client',
    'bridge_to_external_mcp_server',
    'bridge_to_external_a2a_client',
    'bridge_to_external_a2a_server'
  ];
  
  return serverManagedTypes.includes(agent.strategyType);
}

/**
 * Checks if a conversation has any server-managed agents
 */
export function hasServerManagedAgents(agents: AgentConfig[]): boolean {
  return agents.some(isServerManaged);
}

/**
 * Filters to only server-managed agents
 */
export function getServerManagedAgents(agents: AgentConfig[]): AgentConfig[] {
  return agents.filter(isServerManaged);
}

/**
 * Filters to only external agents
 */
export function getExternalAgents(agents: AgentConfig[]): AgentConfig[] {
  return agents.filter(agent => !isServerManaged(agent));
}