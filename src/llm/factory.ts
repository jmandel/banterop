import { LLMProvider, LLMProviderConfig } from '../types/llm.types.js';
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

// Get information about all available providers
export function getAvailableProviders(): Array<{
  name: SupportedProvider;
  description: string;
  models: string[];
}> {
  return [
    {
      name: 'google',
      description: 'Google Gemini models via @google/genai',
      models: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro']
    },
    {
      name: 'openrouter',
      description: 'OpenRouter multi-model gateway via OpenAI SDK',
      models: ['openrouter/horizon-beta']
    },
    // Add other providers here as they're implemented
  ];
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