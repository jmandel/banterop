import { describe, test, expect } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { createLLMProvider } from '$llm/factory.js';
import { StaticReplayConfig } from '$lib/types.js';

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
      metadata: { conversationTitle: "Test Conversation" },
      agents: [{
        id: "agent1",
        strategyType: 'static_replay',
        script: [],
        shouldInitiateConversation: true,
        additionalInstructions: instructions
      } as StaticReplayConfig]
    });
      
    expect(conversation.agents.find(a => a.shouldInitiateConversation)?.additionalInstructions).toBe(instructions);
      
    expect(conversation.id).toBeDefined();
    expect(conversation.agents.find(a => a.shouldInitiateConversation)?.id).toBe('agent1');
  });
});