import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { createLLMProvider } from '$llm/factory.js';
import { StaticReplayConfig } from '$lib/types.js';

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
  });

  test('should handle missing instructions', async () => {
    const { conversation } = await orchestrator.createConversation({
      metadata: { conversationTitle: "Test Conversation" },
      agents: [{
        id: "agent1",
        strategyType: 'static_replay',
        script: []
      } as StaticReplayConfig]
    });
      
    expect(conversation.agents.find(a => a.shouldInitiateConversation)?.additionalInstructions).toBeUndefined();
  });
});