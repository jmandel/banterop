import { describe, it, expect } from 'bun:test';
import { encodeConfigToBase64URL, decodeConfigFromBase64URL } from './config-encoding.js';
import { CreateConversationRequest } from '$lib/types.js';

describe('Config Encoding/Decoding', () => {
  const sampleConfig: CreateConversationRequest = {
    metadata: {
      scenarioId: 'test-scenario-123',
      conversationTitle: 'Test Conversation',
      conversationDescription: 'A test conversation for encoding'
    },
    agents: [
      {
        id: 'agent-1',
        strategyType: 'bridge_to_external_mcp_server',
        shouldInitiateConversation: true
      },
      {
        id: 'agent-2',
        strategyType: 'scenario_driven',
        additionalInstructions: 'Be helpful'
      }
    ]
  };

  it('should encode and decode a configuration successfully', () => {
    const encoded = encodeConfigToBase64URL(sampleConfig);
    const decoded = decodeConfigFromBase64URL(encoded);
    
    expect(decoded).toEqual(sampleConfig);
  });

  it('should produce URL-safe base64 output', () => {
    const encoded = encodeConfigToBase64URL(sampleConfig);
    
    // Check that it doesn't contain non-URL-safe characters
    expect(encoded).not.toMatch(/[+/=]/);
    
    // Check that it only contains URL-safe characters
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
  });

  it('should handle configs with special characters', () => {
    const configWithSpecialChars: CreateConversationRequest = {
      metadata: {
        scenarioId: 'test/scenario+123',
        conversationTitle: 'Test=Conversation&More',
        conversationDescription: 'Description with "quotes" and \'apostrophes\''
      },
      agents: [
        {
          id: 'agent/1+2=3',
          strategyType: 'scenario_driven'
        }
      ]
    };
    
    const encoded = encodeConfigToBase64URL(configWithSpecialChars);
    const decoded = decodeConfigFromBase64URL(encoded);
    
    expect(decoded).toEqual(configWithSpecialChars);
  });

  it('should handle minimal configuration', () => {
    const minimalConfig: CreateConversationRequest = {
      metadata: {},
      agents: []
    };
    
    const encoded = encodeConfigToBase64URL(minimalConfig);
    const decoded = decodeConfigFromBase64URL(encoded);
    
    expect(decoded).toEqual(minimalConfig);
  });

  it('should throw error for invalid base64url input', () => {
    expect(() => {
      decodeConfigFromBase64URL('not-valid-base64!@#');
    }).toThrow();
  });

  it('should throw error for non-JSON content', () => {
    // Create a valid base64url string that decodes to non-JSON
    const nonJsonBase64 = btoa('this is not json').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    
    expect(() => {
      decodeConfigFromBase64URL(nonJsonBase64);
    }).toThrow('Failed to parse configuration');
  });

  it('should handle large configurations', () => {
    const largeConfig: CreateConversationRequest = {
      metadata: {
        scenarioId: 'large-scenario',
        conversationTitle: 'Large Test',
        conversationDescription: 'A'.repeat(1000) // Large description
      },
      agents: Array.from({ length: 50 }, (_, i) => ({
        id: `agent-${i}`,
        strategyType: 'scenario_driven' as const,
        additionalInstructions: `Instructions for agent ${i}: ` + 'B'.repeat(100)
      }))
    };
    
    const encoded = encodeConfigToBase64URL(largeConfig);
    const decoded = decodeConfigFromBase64URL(encoded);
    
    expect(decoded).toEqual(largeConfig);
  });

  it('should produce consistent output for same input', () => {
    const encoded1 = encodeConfigToBase64URL(sampleConfig);
    const encoded2 = encodeConfigToBase64URL(sampleConfig);
    
    expect(encoded1).toBe(encoded2);
  });
});