import { LLMProvider, type LLMProviderConfig, type LLMProviderMetadata, type LLMRequest, type LLMResponse } from '$src/types/llm.types';

export class MockLLMProvider extends LLMProvider {
  constructor(config: LLMProviderConfig) {
    super(config);
  }
  
  getMetadata(): LLMProviderMetadata {
    return {
      name: 'mock',
      description: 'Mock LLM Provider for testing',
      models: ['mock-model'],
      defaultModel: 'mock-model',
    };
  }
  
  async complete(request: LLMRequest): Promise<LLMResponse> {
    // Simple mock that echoes the last user message
    const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
    const content = lastUserMessage 
      ? `Mock response to: "${lastUserMessage.content}"`
      : 'Mock response with no user input';
    
    // Simulate some delay
    await new Promise(resolve => setTimeout(resolve, 100));
    
    return {
      content,
      usage: {
        promptTokens: request.messages.reduce((acc, m) => acc + m.content.length, 0),
        completionTokens: content.length,
      },
    };
  }
}