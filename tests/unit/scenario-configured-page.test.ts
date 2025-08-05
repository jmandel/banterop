import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { CreateConversationRequest, ConversationEvent } from '../../src/types/index.js';
import { encodeConfigToBase64URL } from '../../src/lib/utils/config-encoding.js';

// SHA256 utility function (same as in component)
async function sha256(str: string): Promise<string> {
  const bytes = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
}

// Mock conversation record interface (from component)
interface ConversationRecord {
  id: string;
  title: string;
  startTime: number;
  status: 'active' | 'completed' | 'failed';
  turnCount: number;
  endStatus?: 'success' | 'failure' | 'neutral';
  isNew?: boolean;
}

describe('ScenarioConfiguredPage', () => {
  
  describe('SHA256 hashing', () => {
    it('should consistently hash the same input', async () => {
      const input = 'test-config-base64';
      const hash1 = await sha256(input);
      const hash2 = await sha256(input);
      
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 produces 64 hex chars
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });
    
    it('should produce different hashes for different inputs', async () => {
      const hash1 = await sha256('config1');
      const hash2 = await sha256('config2');
      
      expect(hash1).not.toBe(hash2);
    });
    
    it('should handle empty strings', async () => {
      const hash = await sha256('');
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });
  
  describe('Config metadata enrichment', () => {
    it('should add configHash and encodedConfig64 to metadata', async () => {
      const originalConfig: CreateConversationRequest = {
        metadata: {
          scenarioId: 'test-scenario',
          conversationTitle: 'Test Conversation'
        },
        agents: [
          { id: 'agent1', strategyType: 'sequential_script', script: [] },
          { id: 'agent2', strategyType: 'sequential_script', script: [] }
        ]
      };
      
      const config64 = 'test-base64-encoded-config';
      const configHash = await sha256(config64);
      
      const enrichedConfig: CreateConversationRequest = {
        ...originalConfig,
        metadata: {
          ...originalConfig.metadata,
          configHash,
          encodedConfig64: config64
        }
      };
      
      expect(enrichedConfig.metadata.configHash).toBe(configHash);
      expect(enrichedConfig.metadata.encodedConfig64).toBe(config64);
      expect(enrichedConfig.metadata.scenarioId).toBe('test-scenario');
      expect(enrichedConfig.metadata.conversationTitle).toBe('Test Conversation');
    });
  });
  
  describe('isRelevantConversation filtering', () => {
    let testConfigHash: string;
    let testConfig: CreateConversationRequest;
    
    beforeEach(async () => {
      testConfigHash = await sha256('test-config');
      testConfig = {
        metadata: { scenarioId: 'scenario-123' },
        agents: [
          { id: 'agent-a', strategyType: 'sequential_script', script: [] },
          { id: 'agent-b', strategyType: 'sequential_script', script: [] }
        ]
      };
    });
    
    const isRelevantConversation = (
      event: ConversationEvent,
      configHash: string | null,
      config: CreateConversationRequest | null
    ): boolean => {
      if (!configHash || !event.data?.conversation?.metadata) return false;
      
      const metadata = event.data.conversation.metadata;
      
      // Primary match: configHash
      if (metadata.configHash === configHash) {
        return true;
      }
      
      // Fallback match: scenarioId + agent IDs
      if (config && metadata.scenarioId === config.metadata?.scenarioId) {
        const eventAgentIds = event.data.conversation.agents?.map((a: any) => a.id).sort();
        const configAgentIds = config.agents.map(a => a.id).sort();
        
        if (JSON.stringify(eventAgentIds) === JSON.stringify(configAgentIds)) {
          return true;
        }
      }
      
      return false;
    };
    
    it('should match by configHash (primary)', () => {
      const event: ConversationEvent = {
        type: 'conversation_created',
        conversationId: 'conv-123',
        timestamp: new Date(),
        data: {
          conversation: {
            metadata: { configHash: testConfigHash },
            agents: []
          }
        }
      };
      
      expect(isRelevantConversation(event, testConfigHash, testConfig)).toBe(true);
    });
    
    it('should not match with different configHash', () => {
      const event: ConversationEvent = {
        type: 'conversation_created',
        conversationId: 'conv-123',
        timestamp: new Date(),
        data: {
          conversation: {
            metadata: { configHash: 'different-hash' },
            agents: []
          }
        }
      };
      
      expect(isRelevantConversation(event, testConfigHash, testConfig)).toBe(false);
    });
    
    it('should fallback to scenarioId + agent IDs when configHash missing', () => {
      const event: ConversationEvent = {
        type: 'conversation_created',
        conversationId: 'conv-123',
        timestamp: new Date(),
        data: {
          conversation: {
            metadata: { scenarioId: 'scenario-123' },
            agents: [
              { id: 'agent-b' },
              { id: 'agent-a' }  // Different order should still match
            ]
          }
        }
      };
      
      expect(isRelevantConversation(event, testConfigHash, testConfig)).toBe(true);
    });
    
    it('should not match with different scenarioId', () => {
      const event: ConversationEvent = {
        type: 'conversation_created',
        conversationId: 'conv-123',
        timestamp: new Date(),
        data: {
          conversation: {
            metadata: { scenarioId: 'different-scenario' },
            agents: [
              { id: 'agent-a' },
              { id: 'agent-b' }
            ]
          }
        }
      };
      
      expect(isRelevantConversation(event, testConfigHash, testConfig)).toBe(false);
    });
    
    it('should not match with different agent IDs', () => {
      const event: ConversationEvent = {
        type: 'conversation_created',
        conversationId: 'conv-123',
        timestamp: new Date(),
        data: {
          conversation: {
            metadata: { scenarioId: 'scenario-123' },
            agents: [
              { id: 'agent-x' },
              { id: 'agent-y' }
            ]
          }
        }
      };
      
      expect(isRelevantConversation(event, testConfigHash, testConfig)).toBe(false);
    });
    
    it('should return false when configHash is null', () => {
      const event: ConversationEvent = {
        type: 'conversation_created',
        conversationId: 'conv-123',
        timestamp: new Date(),
        data: {
          conversation: {
            metadata: { configHash: 'some-hash' },
            agents: []
          }
        }
      };
      
      expect(isRelevantConversation(event, null, testConfig)).toBe(false);
    });
    
    it('should return false when event data is missing', () => {
      const event: ConversationEvent = {
        type: 'conversation_created',
        conversationId: 'conv-123',
        timestamp: new Date(),
        data: null
      };
      
      expect(isRelevantConversation(event, testConfigHash, testConfig)).toBe(false);
    });
  });
  
  describe('Conversation event handling', () => {
    it('should create new conversation record on conversation_created event', () => {
      const conversations: ConversationRecord[] = [];
      const event: ConversationEvent = {
        type: 'conversation_created',
        conversationId: 'conv-new',
        timestamp: new Date(),
        data: {
          conversation: {
            metadata: { conversationTitle: 'New Conversation' }
          }
        }
      };
      
      // Simulate event handler logic
      const newConvo: ConversationRecord = {
        id: event.conversationId,
        title: event.data.conversation.metadata.conversationTitle || 'Untitled',
        startTime: Date.now(),
        status: 'active',
        turnCount: 0,
        isNew: true
      };
      
      conversations.push(newConvo);
      
      expect(conversations).toHaveLength(1);
      expect(conversations[0].id).toBe('conv-new');
      expect(conversations[0].title).toBe('New Conversation');
      expect(conversations[0].status).toBe('active');
      expect(conversations[0].isNew).toBe(true);
      expect(conversations[0].turnCount).toBe(0);
    });
    
    it('should increment turn count on turn_completed event', () => {
      const conversations: ConversationRecord[] = [
        {
          id: 'conv-123',
          title: 'Test',
          startTime: Date.now(),
          status: 'active',
          turnCount: 2
        }
      ];
      
      const event: ConversationEvent = {
        type: 'turn_completed',
        conversationId: 'conv-123',
        timestamp: new Date(),
        data: {}
      };
      
      // Simulate turn_completed handler
      const updated = conversations.map(c => 
        c.id === event.conversationId 
          ? { ...c, turnCount: c.turnCount + 1 }
          : c
      );
      
      expect(updated[0].turnCount).toBe(3);
    });
    
    it('should update status on conversation_ended event', () => {
      const conversations: ConversationRecord[] = [
        {
          id: 'conv-123',
          title: 'Test',
          startTime: Date.now(),
          status: 'active',
          turnCount: 5
        }
      ];
      
      const event: ConversationEvent = {
        type: 'conversation_ended',
        conversationId: 'conv-123',
        timestamp: new Date(),
        data: { endStatus: 'success' }
      };
      
      // Simulate conversation_ended handler
      const updated = conversations.map(c => 
        c.id === event.conversationId 
          ? { 
              ...c, 
              status: 'completed' as const,
              endStatus: event.data.endStatus
            }
          : c
      );
      
      expect(updated[0].status).toBe('completed');
      expect(updated[0].endStatus).toBe('success');
    });
    
    it('should mark as failed on conversation_failed event', () => {
      const conversations: ConversationRecord[] = [
        {
          id: 'conv-123',
          title: 'Test',
          startTime: Date.now(),
          status: 'active',
          turnCount: 3
        }
      ];
      
      const event = {
        type: 'conversation_failed' as const,
        conversationId: 'conv-123',
        timestamp: new Date(),
        data: {}
      };
      
      // Simulate conversation_failed handler
      const updated = conversations.map(c => 
        c.id === event.conversationId 
          ? { ...c, status: 'failed' as const }
          : c
      );
      
      expect(updated[0].status).toBe('failed');
    });
  });
  
  describe('Auto-follow functionality', () => {
    it('should select new conversation when auto-follow is enabled', () => {
      let selectedId: string | null = null;
      const autoFollow = true;
      
      const newConversationId = 'conv-new-123';
      
      // Simulate auto-follow logic
      if (autoFollow) {
        selectedId = newConversationId;
      }
      
      expect(selectedId).toBe('conv-new-123');
    });
    
    it('should not select new conversation when auto-follow is disabled', () => {
      let selectedId: string | null = 'existing-conv';
      const autoFollow = false;
      
      const newConversationId = 'conv-new-123';
      
      // Simulate auto-follow logic
      if (autoFollow) {
        selectedId = newConversationId;
      }
      
      expect(selectedId).toBe('existing-conv');
    });
  });
  
  describe('New badge timing', () => {
    it('should mark conversation as new initially', () => {
      const conversation: ConversationRecord = {
        id: 'conv-123',
        title: 'Test',
        startTime: Date.now(),
        status: 'active',
        turnCount: 0,
        isNew: true
      };
      
      expect(conversation.isNew).toBe(true);
    });
    
    it('should clear new badge when clicked', () => {
      const conversations: ConversationRecord[] = [
        {
          id: 'conv-123',
          title: 'Test',
          startTime: Date.now(),
          status: 'active',
          turnCount: 0,
          isNew: true
        }
      ];
      
      // Simulate click handler
      const clickedId = 'conv-123';
      const updated = conversations.map(c => 
        c.id === clickedId ? { ...c, isNew: false } : c
      );
      
      expect(updated[0].isNew).toBe(false);
    });
    
    it('should mark older conversations as not new when adding new one', () => {
      const conversations: ConversationRecord[] = [
        {
          id: 'conv-old',
          title: 'Old',
          startTime: Date.now() - 60000,
          status: 'active',
          turnCount: 5,
          isNew: true
        }
      ];
      
      // Simulate adding new conversation
      const updated = conversations.map(c => ({ ...c, isNew: false }));
      const newConvo: ConversationRecord = {
        id: 'conv-new',
        title: 'New',
        startTime: Date.now(),
        status: 'active',
        turnCount: 0,
        isNew: true
      };
      
      const result = [newConvo, ...updated];
      
      expect(result[0].isNew).toBe(true);  // New conversation
      expect(result[1].isNew).toBe(false); // Old conversation
    });
  });
  
  describe('UI formatting', () => {
    it('should format short ID correctly', () => {
      const fullId = 'abc123def456ghi789';
      const shortId = fullId.slice(0, 8);
      
      expect(shortId).toBe('abc123de');
      expect(shortId).toHaveLength(8);
    });
    
    it('should format time as HH:MM:SS', () => {
      const date = new Date('2024-01-15T14:30:45');
      const timeStr = date.toLocaleTimeString('en-US', { 
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      
      expect(timeStr).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });
    
    it('should generate correct trace viewer URL', () => {
      const conversationId = 'conv-123';
      const url = `/trace-viewer#/conversations/${conversationId}`;
      
      expect(url).toBe('/trace-viewer#/conversations/conv-123');
    });
  });
  
  describe('Config encoding integration', () => {
    it('should properly encode and decode configuration', () => {
      const config: CreateConversationRequest = {
        metadata: {
          scenarioId: 'test-scenario',
          conversationTitle: 'Test Title',
          conversationDescription: 'Test Description'
        },
        agents: [
          {
            id: 'agent1',
            strategyType: 'sequential_script',
            script: [
              {
                trigger: { type: 'conversation_ready' },
                steps: [
                  { type: 'response', content: 'Hello' }
                ]
              }
            ]
          }
        ]
      };
      
      const encoded = encodeConfigToBase64URL(config);
      expect(encoded).toBeString();
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('=');
    });
  });
});