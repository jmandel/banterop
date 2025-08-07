import { createLLMProvider } from '$llm/factory.js';
import { LLMProvider } from 'src/types/llm.types.js';

export interface ProviderManager {
  providers: Map<string, LLMProvider>;
  getProviderForModel(model?: string): LLMProvider | null;
  getDefaultProvider(): LLMProvider;
  getAllProviders(): LLMProvider[];
}

/**
 * Initialize all available LLM providers based on environment variables
 * and provide a unified interface for selecting providers by model
 */
export function initializeProviders(): ProviderManager {
  const providers = new Map<string, LLMProvider>();
  const providerList: LLMProvider[] = [];

  // Initialize Google provider if API key is available
  if (process.env.GEMINI_API_KEY) {
    const googleProvider = createLLMProvider({ 
      provider: 'google', 
      apiKey: process.env.GEMINI_API_KEY 
    });
    providers.set('google', googleProvider);
    providerList.push(googleProvider);
    console.log('[ProviderManager] Google provider initialized with models:', googleProvider.getSupportedModels());
  }

  // Initialize OpenRouter provider if API key is available
  if (process.env.OPENROUTER_API_KEY) {
    const openrouterProvider = createLLMProvider({ 
      provider: 'openrouter', 
      apiKey: process.env.OPENROUTER_API_KEY 
    });
    providers.set('openrouter', openrouterProvider);
    providerList.push(openrouterProvider);
    console.log('[ProviderManager] OpenRouter provider initialized with models:', openrouterProvider.getSupportedModels());
  }

  // Determine default provider based on LLM_MODEL env var
  const requestedModel = process.env.LLM_MODEL || 'gemini-2.5-flash-lite';
  let defaultProvider: LLMProvider | null = null;

  // Find provider that supports the requested model
  for (const provider of providerList) {
    if (provider.getSupportedModels().includes(requestedModel)) {
      defaultProvider = provider;
      console.log(`[ProviderManager] Selected default provider for model '${requestedModel}'`);
      break;
    }
  }

  // If no provider supports the requested model, use first available
  if (!defaultProvider && providerList.length > 0) {
    defaultProvider = providerList[0];
    console.log(`[ProviderManager] Model '${requestedModel}' not found, using first available provider`);
  }

  if (!defaultProvider) {
    throw new Error('No LLM provider configured. Please set GEMINI_API_KEY or OPENROUTER_API_KEY environment variable.');
  }

  return {
    providers,
    
    getProviderForModel(model?: string): LLMProvider | null {
      if (!model) return null;
      
      // Check each provider to see if it supports this model
      for (const provider of providerList) {
        if (provider.getSupportedModels().includes(model)) {
          return provider;
        }
      }
      return null;
    },
    
    getDefaultProvider(): LLMProvider {
      return defaultProvider!;
    },
    
    getAllProviders(): LLMProvider[] {
      return providerList;
    }
  };
}

// Create a singleton instance
export const providerManager = initializeProviders();