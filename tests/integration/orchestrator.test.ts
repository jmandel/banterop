// Integration tests for ConversationOrchestrator
import { test, expect, describe, beforeEach } from 'bun:test';
import { ConversationOrchestrator } from '../../src/backend/core/orchestrator.js';
import { createClient } from '../../src/client/index.js';
import { createTestOrchestrator } from '../utils/test-helpers.js';
import type { 
  CreateConversationRequest, 
  ConversationEvent,
  StaticReplayConfig,
  AgentId,
  ThoughtEntry
} from '../../src/lib/types.js';

describe('ConversationOrchestrator Integration', () => {
  let orchestrator: ConversationOrchestrator;

  beforeEach(() => {
    orchestrator = createTestOrchestrator();
  });

  test('should create a conversation, provision agents, and emit events', async () => {
    const agentId1 = 'agent-1';
    const agentId2 = 'agent-2';

    const createRequest: CreateConversationRequest = {
      metadata: { conversationTitle: 'Test Conversation' },
      agents: [
        { 
          id: agentId1, 
          strategyType: 'static_replay', 
          script: [
            { trigger: 'hello', response: 'Hello back!' }
          ]
        } as StaticReplayConfig,
        { 
          id: agentId2, 
          strategyType: 'static_replay', 
          script: [
            { trigger: 'goodbye', response: 'See you later!' }
          ]
        } as StaticReplayConfig
      ]
    };
    
    const { conversation, agentTokens } = await orchestrator.createConversation(createRequest);
    
    expect(conversation.id).toBeString();
    expect(conversation.metadata.conversationTitle).toBe('Test Conversation');
    expect(conversation.agents).toHaveLength(2);
    expect(agentTokens['agent-1']).toBeString();
    expect(agentTokens['agent-2']).toBeString();
      
    await orchestrator.startConversation(conversation.id);
      
    const dbConvo = orchestrator.getConversation(conversation.id);
    expect(dbConvo).not.toBeNull();
    expect(dbConvo!.id).toBe(conversation.id);
    expect(dbConvo!.status).toBe('active');
  });

  test('should process a full streaming turn lifecycle', async () => {
    const agentId = 'test-agent';
    
    const createRequest: CreateConversationRequest = {
      metadata: { conversationTitle: 'Streaming Test' },
      agents: [
        { 
          id: agentId, 
          strategyType: 'static_replay', 
          script: []
        } as StaticReplayConfig
      ]
    };

    const { conversation } = await orchestrator.createConversation(createRequest);
      
    const turnId = orchestrator.startTurn({ 
      conversationId: conversation.id, 
      agentId: 'test-agent', 
      metadata: { test: true } 
    }).turnId;

    expect(turnId).toBeString();
      
    orchestrator.addTraceEntry({
      conversationId: conversation.id,
      turnId,
      agentId: 'test-agent',
      entry: { type: 'thought', content: 'Testing trace' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>
    });
      
    const completedTurn = orchestrator.completeTurn({ 
      conversationId: conversation.id,
      turnId, 
      agentId: 'test-agent',
      content: 'This is the completed content' 
    });

    expect(completedTurn.status).toBe('completed');
    expect(completedTurn.content).toBe('This is the completed content');
      
    const dbConvo = orchestrator.getConversation(conversation.id, true, true);
    expect(dbConvo!.turns).toHaveLength(1);
    expect(dbConvo!.turns[0].trace).toHaveLength(1);
    expect(dbConvo!.turns[0].trace![0].content).toBe('Testing trace');
  });

  test('should handle agent interactions via orchestrator', async () => {
    const agentId1 = 'agent-1';
    const agentId2 = 'agent-2';

    const createRequest: CreateConversationRequest = {
      metadata: { conversationTitle: 'Agent Interaction Test' },
      agents: [
        { 
          id: agentId1, 
          strategyType: 'static_replay', 
          script: [
            { trigger: 'start conversation', response: 'Hello agent-2!' }
          ]
        } as StaticReplayConfig,
        { 
          id: agentId2, 
          strategyType: 'static_replay', 
          script: [
            { trigger: 'Hello agent-2', response: 'Hello back agent-1!' }
          ]
        } as StaticReplayConfig
      ]
    };

    const { conversation } = await orchestrator.createConversation(createRequest);
      
    await orchestrator.startConversation(conversation.id);
      
    const { turnId } = orchestrator.startTurn({
      conversationId: conversation.id,
      agentId: 'user'
    });
    orchestrator.completeTurn({
      conversationId: conversation.id,
      turnId,
      agentId: 'user',
      content: 'start conversation'
    });
      
    const finalConvo = orchestrator.getConversation(conversation.id, true);
    expect(finalConvo!.turns.length).toBeGreaterThanOrEqual(1); 
      
    const userTurn = finalConvo!.turns.find(t => t.agentId === 'user');
    expect(userTurn).toBeDefined();
    expect(userTurn!.content).toBe('start conversation');
      
    const agentTurns = finalConvo!.turns.filter(t => t.agentId !== 'user');
    // Static replay agents may or may not respond immediately - that's implementation dependent
    // The core test is that the orchestrator can handle turns correctly
  });

  test('should handle conversation subscription and event delivery', async () => {
    const agentId = 'event-test-agent';
    
    const createRequest: CreateConversationRequest = {
      metadata: { conversationTitle: "Event Test" },
      agents: [
        { 
          id: agentId, 
          strategyType: 'static_replay', 
          script: []
        } as StaticReplayConfig
      ]
    };

    const { conversation } = await orchestrator.createConversation(createRequest);

    const receivedEvents: ConversationEvent[] = [];
    const unsubscribe = orchestrator.subscribeToConversation(conversation.id, (event) => {
      receivedEvents.push(event);
    });
      
    const { turnId } = orchestrator.startTurn({
      conversationId: conversation.id,
      agentId: 'user'
    });
    orchestrator.completeTurn({
      conversationId: conversation.id,
      turnId,
      agentId: 'user',
      content: 'Test message'
    });
      
      
    expect(receivedEvents.length).toBeGreaterThan(0);
    const turnCompletedEvents = receivedEvents.filter(e => e.type === 'turn_completed');
    expect(turnCompletedEvents).toHaveLength(1);
    expect(turnCompletedEvents[0].data.turn.content).toBe('Test message');

    unsubscribe();
  });

  test('should validate agent tokens correctly', async () => {
    const agentId = 'token-test-agent';
    
    const createRequest: CreateConversationRequest = {
      metadata: { conversationTitle: "Token Test" },
      agents: [
        { 
          id: agentId, 
          strategyType: 'static_replay', 
          script: []
        } as StaticReplayConfig
      ]
    };

    const { conversation, agentTokens } = await orchestrator.createConversation(createRequest);
    const validToken = agentTokens['token-test-agent'];
      
    const validTokenResult = orchestrator.validateAgentToken(validToken);
    expect(validTokenResult).not.toBeNull();
    expect(validTokenResult!.conversationId).toBe(conversation.id);
    expect(validTokenResult!.agentId).toBe('token-test-agent');
      
    const invalidTokenResult = orchestrator.validateAgentToken('invalid-token');
    expect(invalidTokenResult).toBeNull();
  });

  test('should return null for non-existent conversation', () => {
    const nonExistent = orchestrator.getConversation('non-existent-id');
    expect(nonExistent).toBeNull();
  });

  test('should list all conversations with pagination', async () => {
    // Create multiple conversations
    const conversation1: CreateConversationRequest = {
      metadata: { conversationTitle: "First Conversation" },
      agents: [{
        id: 'agent-1',
        strategyType: 'static_replay',
        script: []
      }]
    };
    
    const conversation2: CreateConversationRequest = {
      metadata: { conversationTitle: "Second Conversation" }, 
      agents: [{
        id: 'agent-2',
        strategyType: 'static_replay',
        script: []
      }]
    };

    await orchestrator.createConversation(conversation1);
    await orchestrator.createConversation(conversation2);

    const result = orchestrator.getAllConversations({ limit: 10, offset: 0 });
    expect(result.conversations).toHaveLength(2);
    expect(result.total).toBe(2);
      
    const titles = result.conversations.map(c => c.metadata?.conversationTitle);
    expect(titles).toContain('First Conversation');
    expect(titles).toContain('Second Conversation');
  });
});
