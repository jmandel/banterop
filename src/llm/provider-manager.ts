import type { Config } from '$src/server/config';
import { LLMProvider, type LLMProviderConfig, type SupportedProvider, type LLMProviderMetadata } from '$src/types/llm.types';
import { GoogleLLMProvider } from './providers/google';
import { OpenRouterLLMProvider } from './providers/openrouter';
import { MockLLMProvider } from './providers/mock';
import { findProviderForModel } from './model-registry';

const PROVIDER_MAP = {
  google: GoogleLLMProvider,
  openrouter: OpenRouterLLMProvider,
  mock: MockLLMProvider,
} as const;

export class ProviderManager {
  constructor(private appConfig: Config) {}

  /**
   * Creates an LLM provider instance based on the requested configuration.
   * Can auto-detect provider from model name, or use explicit provider.
   * 
   * NOTE: In this Connectathon build, we do NOT cache providers.
   * They are cheap to construct and model changes trigger new instances.
   * This keeps behaviour simple and deterministic.
   * 
   * @param config - Configuration with optional model, provider, or apiKey
   * @returns LLMProvider instance configured for the request
   */
  getProvider(config?: Partial<LLMProviderConfig>): LLMProvider {
    let providerName: SupportedProvider;
    const model = config?.model;

    // If a model is specified, try to auto-detect the provider
    if (model && !config?.provider) {
      const detectedProvider = this.findProviderForModel(model);
      if (detectedProvider) {
        providerName = detectedProvider;
      } else {
        throw new Error(`Unknown model '${model}'. Please specify a provider or use a known model name.`);
      }
    } else {
      // Use explicit provider or fall back to default
      providerName = config?.provider ?? this.appConfig.defaultLlmProvider;
    }

    // Create a new provider instance each time (no caching in Connectathon mode)
    return this.createProviderInstance(providerName, config);
  }

  /**
   * Searches all available providers to find which one supports the given model.
   * Checks each provider's model list dynamically.
   */
  private findProviderForModel(modelName: string): SupportedProvider | null {
    // First check the static registry
    const registryProvider = findProviderForModel(modelName);
    if (registryProvider) {
      return registryProvider;
    }

    // Then dynamically check each provider's supported models using static metadata
    for (const [providerName, ProviderClass] of Object.entries(PROVIDER_MAP)) {
      try {
        const metadata = ProviderClass.getMetadata();
        
        // Check if this provider supports the model
        if (metadata.models.includes(modelName)) {
          return providerName as SupportedProvider;
        }
        
        // Also check if model matches when prepended with provider name
        // e.g., "gpt-4" might match "openai/gpt-4" in OpenRouter
        const withPrefix = `${metadata.name}/${modelName}`;
        if (metadata.models.some(m => m === withPrefix || m.endsWith(`/${modelName}`))) {
          return providerName as SupportedProvider;
        }
      } catch {
        // Provider metadata access failed, skip it
        continue;
      }
    }

    return null;
  }

  private createProviderInstance(providerName: SupportedProvider, config?: Partial<LLMProviderConfig>): LLMProvider {
    const ProviderClass = PROVIDER_MAP[providerName];
    if (!ProviderClass) {
      throw new Error(`Unsupported LLM provider: ${providerName}`);
    }

    const apiKey = this.getApiKeyForProvider(providerName, config?.apiKey);

    if (!apiKey && providerName !== 'mock') {
      throw new Error(`API key for provider '${providerName}' not found in configuration or environment variables.`);
    }

    return new ProviderClass({ 
      provider: providerName, 
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(config?.model !== undefined ? { model: config.model } : {})
    });
  }

  private getApiKeyForProvider(providerName: SupportedProvider, overrideKey?: string): string | undefined {
    if (overrideKey) return overrideKey;
    
    if (providerName === 'google') {
      return this.appConfig.googleApiKey;
    } else if (providerName === 'openrouter') {
      return this.appConfig.openRouterApiKey;
    } else if (providerName === 'mock') {
      return 'mock-key'; // Mock provider doesn't need a real key
    }
    
    return undefined;
  }

  /**
   * Returns metadata for all configured providers.
   */
  getAvailableProviders(): LLMProviderMetadata[] {
    return Object.entries(PROVIDER_MAP).map(([_, ProviderClass]) => {
      return ProviderClass.getMetadata();
    });
  }
}