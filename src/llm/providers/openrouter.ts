import OpenAI from 'openai';
import { LLMProvider, LLMRequest, LLMResponse, LLMMessage } from 'src/types/llm.types.js';

export class OpenRouterLLMProvider extends LLMProvider {
  private client: OpenAI | null = null;
  
  constructor(config: { apiKey?: string; model?: string }) {
    // Use provided API key or fall back to environment variable
    const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
    
    super({
      provider: 'openrouter',
      apiKey: apiKey,
      model: config.model || 'openrouter/horizon-beta'
    });
    
    if (apiKey) {
      this.client = new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: apiKey,
      });
    }
  }
  
  getSupportedModels(): string[] {
    // OpenRouter supports many models - these are some popular ones
    return [
      'openrouter/horizon-beta',
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3-opus',
      'anthropic/claude-3-sonnet',
      'anthropic/claude-3-haiku',
      'google/gemini-2.0-flash-exp:free',
      'google/gemini-1.5-flash',
      'google/gemini-1.5-pro',
      'meta-llama/llama-3.3-70b-instruct',
      'meta-llama/llama-3.1-405b-instruct',
      'deepseek/deepseek-v3',
      'qwen/qwen-2-72b-instruct',
      'mistralai/mistral-7b-instruct',
      'mistralai/mixtral-8x7b-instruct',
    ];
  }
  
  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error('OpenRouter client not initialized - API key required');
    }
    
    try {
      const completion = await this.client.chat.completions.create({
        model: request.model || this.config.model || 'openrouter/horizon-beta',
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