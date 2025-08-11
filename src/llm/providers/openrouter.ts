import OpenAI from 'openai';
import { LLMProvider, type LLMProviderConfig, type LLMProviderMetadata, type LLMRequest, type LLMResponse } from '$src/types/llm.types';

export class OpenRouterLLMProvider extends LLMProvider {
  private client: OpenAI;
  
  constructor(config: LLMProviderConfig) {
    super(config);
    if (!config.apiKey) {
      throw new Error('OpenRouter API key is required');
    }
    
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/language-track',
        'X-Title': 'Language Track v3',
      },
    });
  }
  
  static getMetadata(): LLMProviderMetadata {
    return {
      name: 'openrouter',
      description: 'OpenRouter AI Gateway',
      models: [
        'openai/gpt-oss-120b:nitro',
        'qwen/qwen3-235b-a22b-2507:nitro'
      ],
      defaultModel: 'openai/gpt-oss-120b:nitro',
    };
  }
  
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const modelName = request.model || this.config.model || this.getMetadata().defaultModel;
    
    const completion = await this.client.chat.completions.create({
      model: modelName,
      messages: request.messages,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    });
    
    const choice = completion.choices[0];
    if (!choice?.message?.content) {
      throw new Error('No response from OpenRouter');
    }

    console.log(request, choice);
    
    return {
      content: choice.message.content,
      ...(completion.usage ? {
        usage: {
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
        }
      } : {}),
    };
  }
}
