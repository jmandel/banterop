import { CreateConversationRequest, AgentConfig } from '$lib/types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates a CreateConversationRequest with bridge-specific constraints
 * @param config The configuration to validate
 * @returns ValidationResult with errors and warnings
 */
export function validateCreateConversationConfigV2(config: CreateConversationRequest): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Basic structure validation
  if (!config || typeof config !== 'object') {
    errors.push('Configuration must be an object');
    return { valid: false, errors, warnings };
  }

  if (!config.metadata || typeof config.metadata !== 'object') {
    errors.push('Configuration must have a metadata object');
  }

  if (!config.agents || !Array.isArray(config.agents)) {
    errors.push('Configuration must have an agents array');
  }

  // Validate metadata
  if (config.metadata) {
    if (!config.metadata.scenarioId) {
      errors.push('metadata.scenarioId is required');
    }
  }

  // Validate agents
  if (Array.isArray(config.agents)) {
    // Check for unique agent IDs
    const agentIds = new Set<string>();
    config.agents.forEach((agent, index) => {
      if (!agent.id) {
        errors.push(`Agent at index ${index} must have an id`);
      } else if (agentIds.has(agent.id)) {
        errors.push(`Duplicate agent id: ${agent.id}`);
      } else {
        agentIds.add(agent.id);
      }

      if (!agent.strategyType) {
        errors.push(`Agent ${agent.id || `at index ${index}`} must have a strategyType`);
      }
    });

    // Count bridge agents
    const bridgeAgents = config.agents.filter(agent => 
      agent.strategyType === 'bridge_to_external_mcp_client' ||
      agent.strategyType === 'bridge_to_external_mcp_server' ||
      agent.strategyType === 'bridge_to_external_a2a_client' ||
      agent.strategyType === 'bridge_to_external_a2a_server'
    );

    if (bridgeAgents.length > 1) {
      errors.push('Only one bridged agent is allowed per conversation');
    }

    // Count initiators
    const initiators = config.agents.filter(agent => agent.shouldInitiateConversation);
    if (initiators.length > 1) {
      errors.push('Only one agent can be marked as shouldInitiateConversation');
    }

    // MCP server mode specific validations
    const mcpServerAgent = config.agents.find(agent => 
      agent.strategyType === 'bridge_to_external_mcp_server'
    );

    if (mcpServerAgent) {
      // In MCP server mode, the bridge agent should be the initiator
      if (!mcpServerAgent.shouldInitiateConversation) {
        warnings.push('In MCP server mode, the bridge agent is typically the initiator');
      }

      // Check if there are internal agents marked as initiator
      const internalInitiators = config.agents.filter(agent => 
        agent.shouldInitiateConversation && 
        agent.id !== mcpServerAgent.id
      );

      if (internalInitiators.length > 0) {
        warnings.push('In MCP server mode, internal agents should not be marked as initiators (external activation is expected)');
      }
    }

    // Check for at least one initiator in internal-only runs
    if (bridgeAgents.length === 0 && initiators.length === 0) {
      warnings.push('No agent is marked as initiator. First message must be sent via UI or internal logic');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Checks if a configuration has a bridged agent
 */
export function hasBridgedAgent(config: CreateConversationRequest): boolean {
  return config.agents.some(agent => 
    agent.strategyType === 'bridge_to_external_mcp_client' ||
    agent.strategyType === 'bridge_to_external_mcp_server' ||
    agent.strategyType === 'bridge_to_external_a2a_client' ||
    agent.strategyType === 'bridge_to_external_a2a_server'
  );
}

/**
 * Gets the bridged agent from a configuration (if any)
 */
export function getBridgedAgent(config: CreateConversationRequest): AgentConfig | undefined {
  return config.agents.find(agent => 
    agent.strategyType === 'bridge_to_external_mcp_client' ||
    agent.strategyType === 'bridge_to_external_mcp_server' ||
    agent.strategyType === 'bridge_to_external_a2a_client' ||
    agent.strategyType === 'bridge_to_external_a2a_server'
  );
}