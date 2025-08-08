import type { Config } from '$src/server/config';
import { LLMProvider, type LLMProviderConfig, type SupportedProvider, type LLMProviderMetadata } from '$src/types/llm.types';
import { GoogleLLMProvider } from './providers/google';
import { OpenRouterLLMProvider } from './providers/openrouter';
import { MockLLMProvider } from './providers/mock';

const PROVIDER_MAP = {
  google: GoogleLLMProvider,
  openrouter: OpenRouterLLMProvider,
  mock: MockLLMProvider,
} as const;

export class ProviderManager {
  constructor(private appConfig: Config) {}

  /**
   * Creates an LLM provider instance based on the requested configuration.
   * If a provider is not specified, it uses the default from the app config.
   */
  getProvider(config?: Partial<LLMProviderConfig>): LLMProvider {
    const providerName = config?.provider ?? this.appConfig.defaultLlmProvider;
    const model = config?.model;

    const ProviderClass = PROVIDER_MAP[providerName];
    if (!ProviderClass) {
      throw new Error(`Unsupported LLM provider: ${providerName}`);
    }

    // Pass the correct API key from the app's central config
    let apiKey: string | undefined;
    if (providerName === 'google') {
      apiKey = config?.apiKey ?? this.appConfig.googleApiKey;
    } else if (providerName === 'openrouter') {
      apiKey = config?.apiKey ?? this.appConfig.openRouterApiKey;
    } else if (providerName === 'mock') {
      apiKey = 'mock-key'; // Mock provider doesn't need a real key
    }

    if (!apiKey && providerName !== 'mock') {
      throw new Error(`API key for provider '${providerName}' not found in configuration or environment variables.`);
    }

    return new ProviderClass({ 
      provider: providerName, 
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(model !== undefined ? { model } : {})
    });
  }

  /**
   * Returns metadata for all configured providers.
   */
  getAvailableProviders(): LLMProviderMetadata[] {
    return Object.entries(PROVIDER_MAP).map(([name, ProviderClass]) => {
      const tempInstance = new ProviderClass({ 
        provider: name as SupportedProvider, 
        apiKey: 'temp' 
      });
      return tempInstance.getMetadata();
    });
  }
}