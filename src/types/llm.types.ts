// Model-agnostic LLM types
export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

export interface LLMTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface LLMToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMToolResponse {
  name: string;
  content: string;
  error?: string;
}

// Provider configuration
export interface LLMProviderConfig {
  provider: 'google' | 'openai' | 'anthropic' | 'local';
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

// Abstract LLM provider interface
export abstract class LLMProvider {
  protected config: LLMProviderConfig;
  
  constructor(config: LLMProviderConfig) {
    this.config = config;
  }
  
  abstract generateResponse(request: LLMRequest): Promise<LLMResponse>;
  
  abstract generateWithTools?(
    request: LLMRequest,
    tools: LLMTool[],
    toolHandler: (call: LLMToolCall) => Promise<LLMToolResponse>
  ): Promise<LLMResponse>;
  
  abstract isAvailable(): Promise<boolean>;
  
  abstract getSupportedModels(): string[];
}