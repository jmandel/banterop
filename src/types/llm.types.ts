export interface LLMProvider {
  name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export interface LLMRequest {
  model?: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: LLMTool[];
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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