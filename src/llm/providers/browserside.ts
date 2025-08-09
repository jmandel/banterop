import { LLMProvider, type LLMProviderConfig, type LLMProviderMetadata, type LLMRequest, type LLMResponse } from '$src/types/llm.types';

export class BrowsersideLLMProvider extends LLMProvider {
  private serverUrl: string;
  private cachedModels: string[] | null = null;
  private cachedDefaultModel: string | null = null;
  
  constructor(config: LLMProviderConfig & { serverUrl?: string }) {
    super(config);
    this.serverUrl = config.serverUrl || '';
  }
  
  static getMetadata(): LLMProviderMetadata {
    return {
      name: 'browserside' as any,
      description: 'Browser-side provider that proxies to server LLM API',
      models: [],
      defaultModel: '',
    };
  }
  
  getMetadata(): LLMProviderMetadata {
    return {
      name: 'browserside' as any,
      description: 'Browser-side provider that proxies to server LLM API',
      models: this.cachedModels || [],
      defaultModel: this.cachedDefaultModel || '',
    };
  }
  
  async fetchAvailableModels(): Promise<void> {
    if (this.cachedModels) {
      return;
    }
    
    const response = await fetch(`${this.serverUrl}/llm/providers`);
    if (!response.ok) {
      throw new Error(`Failed to fetch providers from server: ${response.statusText}`);
    }
    
    const providers: LLMProviderMetadata[] = await response.json();
    
    const allModels: string[] = [];
    let defaultModel = '';
    
    for (const provider of providers) {
      allModels.push(...provider.models);
      if (!defaultModel && provider.defaultModel) {
        defaultModel = provider.defaultModel;
      }
    }
    
    this.cachedModels = allModels;
    this.cachedDefaultModel = defaultModel;
  }
  
  async complete(request: LLMRequest): Promise<LLMResponse> {
    await this.fetchAvailableModels();
    
    const response = await fetch(`${this.serverUrl}/llm/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: request.messages,
        model: request.model || this.config.model,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        tools: request.tools,
      }),
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`Server LLM API error: ${error.error || error.message || response.statusText}`);
    }
    
    const result: LLMResponse = await response.json();
    return result;
  }
}