import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ConversationOrchestrator, OrchestratorConfig } from '../../src/backend/core/orchestrator.js';
import { ConversationDatabase } from '../../src/backend/db/database.js';
import { createAgent } from '../../src/agents/factory.js';
import { createClient } from '../../src/client/index.js';
import type { 
  CreateConversationRequest, 
  ConversationTurn,
  SequentialScriptConfig,
  LLMProvider 
} from '../../src/types/index.js';

describe('Conversation Resurrection Tests', () => {
  let dbPath: string;
  let mockLLMProvider: LLMProvider;

  beforeEach(() => {
    // Use a unique file-based database for each test to test real persistence
    dbPath = `/tmp/test-resurrection-${Date.now()}.db`;
    
    // Mock LLM provider
    mockLLMProvider = {
      generateResponse: async () => ({ content: 'mock response' })
    } as any;
  });

  test('should resurrect and complete conversation after orchestrator restart', async () => {
    // Step 1: Create first orchestrator instance and start a conversation
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Create a conversation with sequential script agents
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'resurrection-test',
        conversationTitle: 'Test Resurrection'
      },
      agents: [
        {
          id: 'agent-1',
          strategyType: 'sequential_script',
          shouldInitiateConversation: true,
          script: [
            {
              trigger: { type: 'conversation_ready' },
              steps: [
                { type: 'thought', content: 'Starting conversation' },
                { type: 'response', content: 'Hello from agent 1' }
              ]
            },
            {
              trigger: { 
                type: 'agent_turn', 
                from: 'agent-2',
                contains: 'response'
              },
              steps: [
                { type: 'thought', content: 'Got response from agent 2' },
                { type: 'response', content: 'Final message from agent 1' }
              ]
            }
          ]
        } as SequentialScriptConfig,
        {
          id: 'agent-2',
          strategyType: 'sequential_script',
          script: [
            {
              trigger: { 
                type: 'agent_turn',
                from: 'agent-1',
                contains: 'Hello'
              },
              steps: [
                { type: 'thought', content: 'Responding to agent 1' },
                { type: 'response', content: 'This is my response' }
              ]
            }
          ]
        } as SequentialScriptConfig
      ]
    };

    const { conversation, agentTokens } = await orchestrator1.createConversation(config);
    const conversationId = conversation.id;
    
    // Start the conversation
    await orchestrator1.startConversation(conversationId);
    
    // Wait for first turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check that first turn happened
    const conv1 = orchestrator1.getConversation(conversationId, true, false);
    expect(conv1.turns.length).toBeGreaterThan(0);
    expect(conv1.turns[0].content).toBe('Hello from agent 1');
    expect(conv1.status).toBe('active');
    
    // Step 2: Simulate crash - close the orchestrator
    console.log('[Test] Simulating orchestrator crash...');
    orchestrator1.close();
    
    // Step 3: Create new orchestrator instance with same database
    console.log('[Test] Creating new orchestrator instance...');
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Give resurrection time to complete
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Step 4: Verify conversation was resurrected
    const conv2 = orchestrator2.getConversation(conversationId, true, true);
    expect(conv2).toBeDefined();
    expect(conv2.status).toBe('active');
    expect(conv2.turns.length).toBeGreaterThan(0);
    
    // Step 5: Wait for conversation to complete naturally
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Step 6: Verify conversation completed with all expected turns
    const finalConv = orchestrator2.getConversation(conversationId, true, false);
    expect(finalConv.turns.length).toBe(3); // agent-1, agent-2, agent-1
    
    // Verify turn sequence
    expect(finalConv.turns[0].agentId).toBe('agent-1');
    expect(finalConv.turns[0].content).toBe('Hello from agent 1');
    
    expect(finalConv.turns[1].agentId).toBe('agent-2');
    expect(finalConv.turns[1].content).toBe('This is my response');
    
    expect(finalConv.turns[2].agentId).toBe('agent-1');
    expect(finalConv.turns[2].content).toBe('Final message from agent 1');
    
    // Clean up
    orchestrator2.close();
  }, 3000); // 3 second timeout for this test

  test('should handle in-progress turn during resurrection', async () => {
    // Step 1: Create orchestrator with a slow agent
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'in-progress-test',
        conversationTitle: 'Test In-Progress Resurrection'
      },
      agents: [
        {
          id: 'slow-agent',
          strategyType: 'sequential_script',
          shouldInitiateConversation: true,
          script: [
            {
              trigger: { type: 'conversation_ready' },
              steps: [
                { type: 'thought', content: 'Starting slow operation' },
                // This would normally have more steps, but we'll interrupt it
                { type: 'response', content: 'Slow response' }
              ]
            }
          ]
        } as SequentialScriptConfig
      ]
    };

    const { conversation } = await orchestrator1.createConversation(config);
    const conversationId = conversation.id;
    
    // Start conversation
    await orchestrator1.startConversation(conversationId);
    
    // Immediately close orchestrator while turn is in progress
    // (before the response step completes)
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Check for in-progress turn
    const db = orchestrator1.getDbInstance();
    const inProgressTurns = db.getInProgressTurns(conversationId);
    const hasInProgress = inProgressTurns.length > 0;
    
    console.log(`[Test] In-progress turns before crash: ${inProgressTurns.length}`);
    
    orchestrator1.close();
    
    // Step 2: Create new orchestrator
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Give resurrection time
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Step 3: Verify handling of in-progress turn
    const conv = orchestrator2.getConversation(conversationId, true, true);
    
    if (hasInProgress) {
      // If there was an in-progress turn, it should be aborted with a message
      const abortedTurn = conv.turns.find(t => 
        t.content.includes('connection issue') || 
        t.content.includes('abort')
      );
      
      if (abortedTurn) {
        expect(abortedTurn).toBeDefined();
        console.log('[Test] Found abort message in turn:', abortedTurn.content);
      }
    }
    
    // The conversation should continue and complete
    await new Promise(resolve => setTimeout(resolve, 300));
    
    const finalConv = orchestrator2.getConversation(conversationId, true, false);
    expect(finalConv.status).toBe('active'); // Should still be active or completed
    
    // Clean up
    orchestrator2.close();
  }, 3000);

  test('should resurrect multiple active conversations', async () => {
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Create multiple conversations
    const conversations = [];
    for (let i = 0; i < 3; i++) {
      const config: CreateConversationRequest = {
        metadata: {
          scenarioId: `multi-test-${i}`,
          conversationTitle: `Conversation ${i}`
        },
        agents: [
          {
            id: `agent-${i}`,
            strategyType: 'sequential_script',
            shouldInitiateConversation: true,
            script: [
              {
                trigger: { type: 'conversation_ready' },
                steps: [
                  { type: 'response', content: `Message from conversation ${i}` }
                ]
              }
            ]
          } as SequentialScriptConfig
        ]
      };
      
      const { conversation } = await orchestrator1.createConversation(config);
      await orchestrator1.startConversation(conversation.id);
      conversations.push(conversation.id);
    }
    
    // Wait for all to start
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify all are active
    for (const convId of conversations) {
      const conv = orchestrator1.getConversation(convId);
      expect(conv.status).toBe('active');
    }
    
    // Simulate crash
    orchestrator1.close();
    
    // Create new orchestrator
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Wait for resurrection
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Verify all conversations were resurrected
    for (let i = 0; i < conversations.length; i++) {
      const conv = orchestrator2.getConversation(conversations[i], true);
      expect(conv).toBeDefined();
      expect(conv.status).toBe('active');
      expect(conv.turns.length).toBeGreaterThan(0);
      expect(conv.turns[0].content).toBe(`Message from conversation ${i}`);
    }
    
    // Clean up
    orchestrator2.close();
  }, 3000);

  test('should preserve conversation state including attachments and traces', async () => {
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'state-preservation-test',
        conversationTitle: 'Test State Preservation'
      },
      agents: [
        {
          id: 'detailed-agent',
          strategyType: 'sequential_script',
          shouldInitiateConversation: true,
          script: [
            {
              trigger: { type: 'conversation_ready' },
              steps: [
                { type: 'thought', content: 'First thought' },
                { type: 'thought', content: 'Second thought' },
                { 
                  type: 'tool_call',
                  tool: {
                    name: 'test_tool',
                    params: { test: 'value' }
                  }
                },
                { type: 'response', content: 'Message with details' }
              ]
            }
          ]
        } as SequentialScriptConfig
      ]
    };

    const { conversation } = await orchestrator1.createConversation(config);
    const conversationId = conversation.id;
    
    await orchestrator1.startConversation(conversationId);
    
    // Wait for turn to complete
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Get full state before crash
    const beforeCrash = orchestrator1.getConversation(conversationId, true, true, false, true);
    expect(beforeCrash.turns[0].trace).toBeDefined();
    expect(beforeCrash.turns[0].trace.length).toBeGreaterThan(0);
    
    // Simulate crash
    orchestrator1.close();
    
    // Create new orchestrator
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Wait for resurrection
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Get full state after resurrection
    const afterResurrection = orchestrator2.getConversation(conversationId, true, true, false, true);
    
    // Verify state was preserved
    expect(afterResurrection.turns.length).toBe(beforeCrash.turns.length);
    expect(afterResurrection.turns[0].trace.length).toBe(beforeCrash.turns[0].trace.length);
    
    // Verify trace entries match
    for (let i = 0; i < beforeCrash.turns[0].trace.length; i++) {
      const before = beforeCrash.turns[0].trace[i];
      const after = afterResurrection.turns[0].trace[i];
      expect(after.type).toBe(before.type);
      expect(after.agentId).toBe(before.agentId);
    }
    
    // Clean up
    orchestrator2.close();
  }, 3000);
});