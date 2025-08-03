import { describe, test, expect } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { createLLMProvider } from '$llm/factory.js';

describe('Simple Instructions Test', () => {
  test('should store and pass initiatingInstructions', async () => {
    const mockLLM = createLLMProvider({
      provider: 'google',
      apiKey: 'test-key',
      model: 'test-model'
    });
    
    const orchestrator = new ConversationOrchestrator(':memory:', mockLLM);
    const instructions = 'Be extra friendly and mention the weather';
    
    const { conversation } = await orchestrator.createConversation({
      name: 'Test Conversation',
      agents: [{
        agentId: { id: 'agent1', label: 'Agent 1', role: 'assistant' },
        strategyType: 'test',
        messageToUseWhenInitiatingConversation: 'Hello!'
      }],
      initiatingAgentId: 'agent1',
      initiatingInstructions: instructions
    });

    // Verify instructions were stored
    expect(conversation.metadata?.initiatingInstructions).toBe(instructions);
    
    // Verify the conversation was created with the right structure
    expect(conversation.id).toBeDefined();
    expect(conversation.metadata?.initiatingAgentId).toBe('agent1');
  });
});