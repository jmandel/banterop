import { LLMProvider, type LLMProviderConfig, type LLMProviderMetadata, type LLMRequest, type LLMResponse } from '$src/types/llm.types';

export class MockLLMProvider extends LLMProvider {
  constructor(config: LLMProviderConfig) {
    super(config);
  }
  
  static getMetadata(): LLMProviderMetadata {
    return {
      name: 'mock',
      description: 'Mock LLM Provider for testing',
      models: ['mock-model'],
      defaultModel: 'mock-model',
    };
  }
  
  async complete(request: LLMRequest): Promise<LLMResponse> {
    // Check if this is a ScenarioDrivenAgent prompt by looking for specific markers
    const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
    const lastContent = lastUserMessage?.content || '';
    
    let content: string;
    
    // If it contains the ScenarioDrivenAgent's response instructions, generate a proper tool call
    if (lastContent.includes('<RESPONSE_INSTRUCTIONS>') && lastContent.includes('<scratchpad>')) {
      // Generate a simple tool call response
      content = `<scratchpad>
I need to respond to the message in the conversation.
The other agent said hello, so I should send a greeting back.
</scratchpad>

\`\`\`json
{
  "name": "send_message_to_agent_conversation",
  "args": {
    "text": "Hello! How can I help you today?"
  }
}
\`\`\``;
    } else {
      // Default mock behavior for non-scenario agents
      content = lastUserMessage 
        ? `Mock response to: "${lastUserMessage.content}"`
        : 'Mock response with no user input';
    }
    
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