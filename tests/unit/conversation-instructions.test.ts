import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { createLLMProvider } from '$llm/factory.js';

describe('Conversation Instructions', () => {
  let orchestrator: ConversationOrchestrator;

  beforeEach(() => {
    const mockLLM = createLLMProvider({
      provider: 'google',
      apiKey: 'test-key',
      model: 'test-model'
    });
    
    orchestrator = new ConversationOrchestrator(':memory:', mockLLM);
  });

  test('should store initiatingInstructions in conversation metadata', async () => {
    const instructions = 'Be extra friendly and mention the weather';
    
    const { conversation } = await orchestrator.createConversation({
      name: 'Test Conversation',
      agents: [{
        agentId: { id: 'agent1', label: 'Agent 1', role: 'assistant' },
        strategyType: 'test'
      }],
      initiatingAgentId: 'agent1',
      initiatingInstructions: instructions
    });

    // Verify instructions were stored in metadata
    expect(conversation.metadata?.initiatingInstructions).toBe(instructions);
  });

  test('should handle missing instructions', async () => {
    const { conversation } = await orchestrator.createConversation({
      name: 'Test Conversation',
      agents: [{
        agentId: { id: 'agent1', label: 'Agent 1', role: 'assistant' },
        strategyType: 'test'
      }]
    });

    // Should not have instructions
    expect(conversation.metadata?.initiatingInstructions).toBeUndefined();
  });
});