import { describe, it, expect } from 'bun:test';
import { 
  validateCreateConversationConfigV2, 
  hasBridgedAgent, 
  getBridgedAgent 
} from './config-validation.js';
import { CreateConversationRequest } from '$lib/types.js';

describe('Config Validation', () => {
  describe('validateCreateConversationConfigV2', () => {
    it('should validate a valid configuration', () => {
      const config: CreateConversationRequest = {
        metadata: {
          scenarioId: 'test-scenario',
          conversationTitle: 'Test'
        },
        agents: [
          {
            id: 'agent-1',
            strategyType: 'scenario_driven'
          },
          {
            id: 'agent-2',
            strategyType: 'scenario_driven',
            shouldInitiateConversation: true
          }
        ]
      };

      const result = validateCreateConversationConfigV2(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should require metadata object', () => {
      const config = {
        agents: []
      } as any;

      const result = validateCreateConversationConfigV2(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Configuration must have a metadata object');
    });

    it('should require scenarioId', () => {
      const config: CreateConversationRequest = {
        metadata: {},
        agents: []
      };

      const result = validateCreateConversationConfigV2(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('metadata.scenarioId is required');
    });

    it('should require unique agent IDs', () => {
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { id: 'agent-1', strategyType: 'scenario_driven' },
          { id: 'agent-1', strategyType: 'scenario_driven' }
        ]
      };

      const result = validateCreateConversationConfigV2(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate agent id: agent-1');
    });

    it('should allow only one bridged agent', () => {
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { id: 'mcp-1', strategyType: 'bridge_to_external_mcp_server' },
          { id: 'mcp-2', strategyType: 'bridge_to_external_mcp_client' }
        ]
      };

      const result = validateCreateConversationConfigV2(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Only one bridged agent is allowed per conversation');
    });

    it('should allow only one initiator', () => {
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { id: 'agent-1', strategyType: 'scenario_driven', shouldInitiateConversation: true },
          { id: 'agent-2', strategyType: 'scenario_driven', shouldInitiateConversation: true }
        ]
      };

      const result = validateCreateConversationConfigV2(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Only one agent can be marked as shouldInitiateConversation');
    });

    it('should warn when MCP server agent is not initiator', () => {
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { id: 'mcp-agent', strategyType: 'bridge_to_external_mcp_server' },
          { id: 'internal', strategyType: 'scenario_driven' }
        ]
      };

      const result = validateCreateConversationConfigV2(config);
      expect(result.valid).toBe(true);
      expect(result.warnings).toContain('In MCP server mode, the bridge agent is typically the initiator');
    });

    it('should warn when internal agent is initiator in MCP server mode', () => {
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { id: 'mcp-agent', strategyType: 'bridge_to_external_mcp_server', shouldInitiateConversation: true },
          { id: 'internal', strategyType: 'scenario_driven', shouldInitiateConversation: true }
        ]
      };

      const result = validateCreateConversationConfigV2(config);
      expect(result.valid).toBe(false); // Should fail due to multiple initiators
      expect(result.errors).toContain('Only one agent can be marked as shouldInitiateConversation');
    });

    it('should warn when no initiator in internal-only run', () => {
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { id: 'agent-1', strategyType: 'scenario_driven' },
          { id: 'agent-2', strategyType: 'scenario_driven' }
        ]
      };

      const result = validateCreateConversationConfigV2(config);
      expect(result.valid).toBe(true);
      expect(result.warnings).toContain('No agent is marked as initiator. First message must be sent via UI or internal logic');
    });

    it('should handle missing agent IDs', () => {
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { strategyType: 'scenario_driven' } as any
        ]
      };

      const result = validateCreateConversationConfigV2(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Agent at index 0 must have an id');
    });

    it('should handle missing strategy type', () => {
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { id: 'agent-1' } as any
        ]
      };

      const result = validateCreateConversationConfigV2(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Agent agent-1 must have a strategyType');
    });
  });

  describe('hasBridgedAgent', () => {
    it('should return true for MCP server bridge', () => {
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { id: 'mcp', strategyType: 'bridge_to_external_mcp_server' }
        ]
      };

      expect(hasBridgedAgent(config)).toBe(true);
    });

    it('should return true for MCP client bridge', () => {
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { id: 'mcp', strategyType: 'bridge_to_external_mcp_client' }
        ]
      };

      expect(hasBridgedAgent(config)).toBe(true);
    });

    it('should return false for no bridge agents', () => {
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { id: 'agent-1', strategyType: 'scenario_driven' },
          { id: 'agent-2', strategyType: 'scenario_driven' }
        ]
      };

      expect(hasBridgedAgent(config)).toBe(false);
    });
  });

  describe('getBridgedAgent', () => {
    it('should return the bridged agent', () => {
      const bridgeAgent = { id: 'mcp', strategyType: 'bridge_to_external_mcp_server' as const };
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { id: 'agent-1', strategyType: 'scenario_driven' },
          bridgeAgent
        ]
      };

      const result = getBridgedAgent(config);
      expect(result).toEqual(bridgeAgent);
    });

    it('should return undefined when no bridged agent', () => {
      const config: CreateConversationRequest = {
        metadata: { scenarioId: 'test' },
        agents: [
          { id: 'agent-1', strategyType: 'scenario_driven' }
        ]
      };

      const result = getBridgedAgent(config);
      expect(result).toBeUndefined();
    });
  });
});