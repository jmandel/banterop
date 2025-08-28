
export type SupportedProvider = 'google' | 'openrouter' | 'mock' | 'browserside';

export type LLMMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type LLMTool = { name: string; description?: string; parameters?: Record<string, unknown> };
export type LLMLoggingMetadata = { conversationId?: string; agentName?: string; turnNumber?: number; scenarioId?: string; stepDescriptor?: string; requestId?: string };
export type LLMRequest = { messages: LLMMessage[]; model?: string; temperature?: number; maxTokens?: number; tools?: LLMTool[]; loggingMetadata?: LLMLoggingMetadata };
export type LLMResponse = { content: string; usage?: { promptTokens?: number; completionTokens?: number } };

export type LLMProviderConfig = { provider: SupportedProvider; apiKey?: string; model?: string; apiBase?: string; providerRouting?: Record<string, unknown> };

export type LLMProviderMetadata = { name: SupportedProvider | string; description: string; models: string[]; defaultModel: string };

export abstract class LLMProvider {
  constructor(protected config: LLMProviderConfig) {}
  abstract getMetadata(): LLMProviderMetadata;
  abstract complete(req: LLMRequest): Promise<LLMResponse>;
  static getMetadata(): LLMProviderMetadata { return { name: 'unknown', description: '', models: [], defaultModel: '' } }
  static isAvailable(_env: Record<string, any>): boolean { return true }
}
