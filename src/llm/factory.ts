import { LLMProvider, LLMProviderConfig, LLMProviderMetadata } from '../types/llm.types.js';
import { GoogleLLMProvider } from './providers/google.js';
import { OpenRouterLLMProvider } from './providers/openrouter.js';

// Registry of available providers
export const LLM_PROVIDERS = {
  google: GoogleLLMProvider,
  openrouter: OpenRouterLLMProvider,
  // Future providers can be added here:
  // openai: OpenAILLMProvider,
  // anthropic: AnthropicLLMProvider,
  // local: LocalLLMProvider,
} as const;

export type SupportedProvider = keyof typeof LLM_PROVIDERS;

// Factory function to create LLM providers
export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  const ProviderClass = LLM_PROVIDERS[config.provider as SupportedProvider];
  
  if (!ProviderClass) {
    throw new Error(`Unsupported LLM provider: ${config.provider}. Supported providers: ${Object.keys(LLM_PROVIDERS).join(', ')}`);
  }
  
  return new ProviderClass(config);
}

// Convenience functions for specific providers
export function createGoogleProvider(apiKey?: string, model?: string): GoogleLLMProvider {
  return new GoogleLLMProvider({ apiKey, model });
}

export function createOpenRouterProvider(apiKey?: string, model?: string): OpenRouterLLMProvider {
  return new OpenRouterLLMProvider({ apiKey, model });
}

// Auto-detect and create provider based on available API keys

// Type for provider classes with static metadata and availability check
interface LLMProviderClass {
  new (config: any): LLMProvider;
  readonly metadata: LLMProviderMetadata;
  isAvailable(): boolean;
}

// Get information about all available providers (filtered by API key availability)
export function getAvailableProviders(): LLMProviderMetadata[] {
  return Object.values(LLM_PROVIDERS)
    .filter(ProviderClass => (ProviderClass as LLMProviderClass).isAvailable())
    .map(ProviderClass => (ProviderClass as LLMProviderClass).metadata);
}

// Utility to check which providers can be initialized with given config
export async function checkProviderAvailability(config: {
  googleApiKey?: string;
  openrouterApiKey?: string;
  // Add other provider keys as needed
}): Promise<Array<{ provider: SupportedProvider; available: boolean; error?: string }>> {
  const results = [];
  
  // Check Google provider
  try {
    const provider = createGoogleProvider(config.googleApiKey);
    results.push({ provider: 'google' as const, available: true });
  } catch (error) {
    results.push({ 
      provider: 'google' as const, 
      available: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
  
  // Check OpenRouter provider
  try {
    const provider = createOpenRouterProvider(config.openrouterApiKey);
    results.push({ provider: 'openrouter' as const, available: true });
  } catch (error) {
    results.push({ 
      provider: 'openrouter' as const, 
      available: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
  
  return results;
}