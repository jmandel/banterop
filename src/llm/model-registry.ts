import type { SupportedProvider } from '$src/types/llm.types';

export interface ModelInfo {
  provider: SupportedProvider;
  isDefault?: boolean;
}

/**
 * Registry mapping model names to their providers.
 * Models can be specified with or without provider prefix.
 */
export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  // Google Gemini models
  'gemini-2.5-flash-lite': { provider: 'google', isDefault: true },
  'gemini-2.5-flash': { provider: 'google' },
  'gemini-2.5-pro': { provider: 'google' },
  'gemini-pro': { provider: 'google' },
  'gemini-pro-vision': { provider: 'google' },
  
  // OpenRouter models (with prefixes)
  'openai/gpt-4-turbo-preview': { provider: 'openrouter' },
  'openai/gpt-4': { provider: 'openrouter' },
  'openai/gpt-3.5-turbo': { provider: 'openrouter', isDefault: true },
  'anthropic/claude-3-opus': { provider: 'openrouter' },
  'anthropic/claude-3-sonnet': { provider: 'openrouter' },
  'anthropic/claude-3-haiku': { provider: 'openrouter' },
  'google/gemini-pro': { provider: 'openrouter' },
  'meta-llama/llama-3-70b': { provider: 'openrouter' },
  
  // Common model names without prefix (will use best available provider)
  'gpt-4-turbo': { provider: 'openrouter' },
  'gpt-4': { provider: 'openrouter' },
  'gpt-3.5-turbo': { provider: 'openrouter' },
  'claude-3-opus': { provider: 'openrouter' },
  'claude-3-sonnet': { provider: 'openrouter' },
  'claude-3-haiku': { provider: 'openrouter' },
  
  // Mock models for testing
  'mock-model': { provider: 'mock', isDefault: true },
  'test-model': { provider: 'mock' },
};

/**
 * Finds the provider for a given model name.
 * Returns null if the model is not found in the registry.
 */
export function findProviderForModel(modelName: string): SupportedProvider | null {
  const modelInfo = MODEL_REGISTRY[modelName];
  return modelInfo?.provider ?? null;
}

/**
 * Gets the default model for a provider.
 */
export function getDefaultModelForProvider(provider: SupportedProvider): string | null {
  for (const [modelName, info] of Object.entries(MODEL_REGISTRY)) {
    if (info.provider === provider && info.isDefault) {
      return modelName;
    }
  }
  return null;
}

/**
 * Lists all models available for a provider.
 */
export function getModelsForProvider(provider: SupportedProvider): string[] {
  return Object.entries(MODEL_REGISTRY)
    .filter(([_, info]) => info.provider === provider)
    .map(([modelName]) => modelName);
}