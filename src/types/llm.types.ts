// Base request/response types
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: LLMTool[];
}

export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: unknown;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

// Provider-specific types
export type SupportedProvider = 'google' | 'openrouter' | 'mock';

export interface LLMProviderConfig {
  provider: SupportedProvider;
  apiKey?: string;
  model?: string;
}

export interface LLMProviderMetadata {
  name: SupportedProvider;
  description: string;
  models: string[];
  defaultModel: string;
}

export abstract class LLMProvider {
  constructor(protected config: LLMProviderConfig) {}
  
  // Static method to get metadata without instantiation
  static getMetadata(): LLMProviderMetadata {
    throw new Error('getMetadata must be implemented by subclass');
  }
  
  // Instance method for backwards compatibility (delegates to static)
  getMetadata(): LLMProviderMetadata {
    return (this.constructor as typeof LLMProvider).getMetadata();
  }
  
  abstract complete(request: LLMRequest): Promise<LLMResponse>;
}