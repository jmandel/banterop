import OpenAI from 'openai';
import { LLMProvider, LLMProviderMetadata, LLMRequest, LLMResponse, LLMMessage } from 'src/types/llm.types.js';

export class OpenRouterLLMProvider extends LLMProvider {
  static readonly metadata: LLMProviderMetadata = {
    name: 'openrouter',
    description: 'OpenRouter multi-model gateway via OpenAI SDK',
    models: [
      'openrouter/horizon-beta',
      'openai/gpt-oss-120b:nitro',
      'openai/gpt-oss-20b:nitro'
    ],
    defaultModel: 'openrouter/horizon-beta'
  };

  static isAvailable(): boolean {
    return !!process.env.OPENROUTER_API_KEY;
  }

  private client: OpenAI | null = null;
  
  constructor(config: { apiKey?: string; model?: string }) {
    // Use provided API key or fall back to environment variable
    const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
    
    super({
      provider: 'openrouter',
      apiKey: apiKey,
      model: config.model || OpenRouterLLMProvider.metadata.defaultModel
    });
    
    if (apiKey) {
      this.client = new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: apiKey,
      });
    }
  }
  
  getSupportedModels(): string[] {
    return OpenRouterLLMProvider.metadata.models;
  }
  
  getDescription(): string {
    return OpenRouterLLMProvider.metadata.description;
  }
  
  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error('OpenRouter client not initialized - API key required');
    }
    
    try {
      console.log("Send llm query to open router", request)
      const completion = await this.client.chat.completions.create({
        model: request.model || this.config.model || OpenRouterLLMProvider.metadata.defaultModel,
        messages: request.messages.map(msg => ({
          role: msg.role as 'system' | 'user' | 'assistant',
          content: msg.content
        })),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
      });
      
      const choice = completion.choices[0];
      
      return {
        content: choice?.message?.content || '',
        finishReason: choice?.finish_reason || 'stop',
        usage: {
          promptTokens: completion.usage?.prompt_tokens || 0,
          completionTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0
        }
      };
    } catch (error) {
      console.error('OpenRouter LLM generation error:', error);
      throw new Error(`OpenRouter LLM generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}