import { LLMProvider, type LLMProviderConfig, type LLMProviderMetadata, type LLMRequest, type LLMResponse } from '$src/types/llm.types';

export class BrowsersideLLMProvider extends LLMProvider {
  static isAvailable(): boolean { return true; }
  private apiBase: string;
  private cachedModels: string[] | null = null;
  private cachedDefaultModel: string | null = null;
  
  constructor(config: LLMProviderConfig & { apiBase?: string; serverUrl?: string }) {
    super(config);
    // Prefer explicit apiBase; fall back to serverUrl with heuristic
    if (config.apiBase) {
      this.apiBase = config.apiBase;
    } else if (config.serverUrl) {
      const s = config.serverUrl.replace(/\/$/, '');
      this.apiBase = s.endsWith('/api') ? s : `${s}/api`;
    } else {
      this.apiBase = '';
    }
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
    
    const response = await fetch(`${this.apiBase}/llm/providers`);
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
    
    const response = await fetch(`${this.apiBase}/llm/complete`, {
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
        loggingMetadata: request.loggingMetadata,
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
