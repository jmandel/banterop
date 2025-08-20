import { LLMProvider, type LLMProviderConfig, type SupportedProvider, type LLMProviderMetadata } from '$src/types/llm.types';
import { GoogleLLMProvider } from './providers/google';
import { OpenRouterLLMProvider } from './providers/openrouter';
import { MockLLMProvider } from './providers/mock';
import { BrowsersideLLMProvider } from './providers/browserside';

const PROVIDER_MAP = {
  google: GoogleLLMProvider,
  openrouter: OpenRouterLLMProvider,
  mock: MockLLMProvider,
  browserside: BrowsersideLLMProvider,
} as const;

export interface LLMConfig {
  defaultLlmProvider: 'google' | 'openrouter' | 'mock' | 'browserside';
  defaultLlmModel?: string | undefined;
  googleApiKey?: string | undefined;
  openRouterApiKey?: string | undefined;
  openRouterProviderConfig?: Record<string, unknown> | undefined;
  serverUrl?: string | undefined; // legacy; will be treated as apiBase if ends with /api
  apiBase?: string | undefined;   // preferred explicit API base (e.g., http://localhost:3000/api)
}

export class LLMProviderManager {
  constructor(private config: LLMConfig) {}

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
    // Use specified model, or fall back to default model from config
    const model = config?.model ?? this.config.defaultLlmModel;

    console.log('[LLMProviderManager] getProvider:', `requestedProvider=${config?.provider || 'auto'}, default=${this.config.defaultLlmProvider}, model=${model || 'default'}`);

    if (config?.provider) {
      providerName = config.provider;
    } else if (this.config.defaultLlmProvider === 'browserside') {
      // Honor explicit default of browserside; do not auto-detect to a server provider
      providerName = 'browserside';
    } else if (model) {
      // If a model is specified and no explicit provider, try to auto-detect the provider
      const detectedProvider = this.findProviderForModel(model);
      if (detectedProvider) {
        providerName = detectedProvider;
      } else {
        throw new Error(`Unknown model '${model}'. Please specify a provider or use a known model name.`);
      }
    } else {
      // Use default
      providerName = this.config.defaultLlmProvider;
    }

    console.log(`[LLMProviderManager] Chosen provider: ${providerName}`);
    // Create a new provider instance each time (no caching in Connectathon mode)
    return this.createProviderInstance(providerName, { ...config, model });
  }

  /**
   * Searches all available providers to find which one supports the given model.
   * Checks each provider's model list dynamically.
   */
  private findProviderForModel(modelName: string): SupportedProvider | null {
    // Single source of truth: check each provider's supported models using filtered metadata
    for (const [providerName, ProviderClass] of Object.entries(PROVIDER_MAP)) {
      try {
        const metadata = this.getFilteredMetadata(providerName as SupportedProvider);
        
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

  /**
   * Return provider metadata with models filtered according to env allow list.
   * Environment variable (per provider, uppercased):
   * - LLM_MODELS_{PROVIDER}_INCLUDE: comma-separated list; if set, only these models are exposed.
   * Example: LLM_MODELS_OPENROUTER_INCLUDE="openai/gpt-oss-120b:nitro,qwen/qwen3-235b-a22b-2507:nitro"
   */
  private getFilteredMetadata(provider: SupportedProvider): LLMProviderMetadata {
    const ProviderClass = PROVIDER_MAP[provider];
    const meta = ProviderClass.getMetadata();
    const envBase = `LLM_MODELS_${provider.toUpperCase()}`;
    const include = (process.env[`${envBase}_INCLUDE`] || '').split(',').map(s => s.trim()).filter(Boolean);
    let models = meta.models.slice();
    let defaultModel = meta.defaultModel;
    if (include.length > 0) {
      // Override built-in list completely, preserving order from INCLUDE
      models = include.slice();
      defaultModel = include[0] || '';
    } else {
      // Keep built-ins; if defaultModel is missing, pick first available
      if (defaultModel && !models.includes(defaultModel)) {
        defaultModel = models[0] || '';
      }
    }
    return { ...meta, models, defaultModel };
  }

  private createProviderInstance(providerName: SupportedProvider, config?: Partial<LLMProviderConfig>): LLMProvider {
    const ProviderClass = PROVIDER_MAP[providerName];
    if (!ProviderClass) {
      throw new Error(`Unsupported LLM provider: ${providerName}`);
    }

    const apiKey = this.getApiKeyForProvider(providerName, config?.apiKey);

    if (!apiKey && providerName !== 'mock' && providerName !== 'browserside') {
      throw new Error(`API key for provider '${providerName}' not found in configuration or environment variables.`);
    }

    const providerConfig = { 
      provider: providerName, 
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(config?.model !== undefined ? { model: config.model } : {}),
      ...(providerName === 'browserside' && (this.config.apiBase || this.config.serverUrl) ? { apiBase: this.config.apiBase || this.config.serverUrl } : {}),
      ...(providerName === 'openrouter' && this.config.openRouterProviderConfig ? { providerRouting: this.config.openRouterProviderConfig } : {})
    };
    
    console.log(`[LLMProviderManager] Creating ${providerName} provider, serverUrl=${(providerConfig as any).serverUrl || 'none'}`);
    
    return new ProviderClass(providerConfig as any);
  }

  private getApiKeyForProvider(providerName: SupportedProvider, overrideKey?: string): string | undefined {
    if (overrideKey) return overrideKey;
    
    if (providerName === 'google') {
      return this.config.googleApiKey;
    } else if (providerName === 'openrouter') {
      return this.config.openRouterApiKey;
    } else if (providerName === 'mock') {
      return 'mock-key'; // Mock provider doesn't need a real key
    } else if (providerName === 'browserside') {
      return undefined; // Browserside provider doesn't need an API key
    }
    
    return undefined;
  }

  /**
   * Returns metadata for all configured providers.
   */
  getAvailableProviders(): (LLMProviderMetadata & { available: boolean })[] {
    return Object.entries(PROVIDER_MAP).map(([name, ProviderClass]) => {
      const available = (ProviderClass as any).isAvailable?.({
        googleApiKey: this.config.googleApiKey,
        openRouterApiKey: this.config.openRouterApiKey,
      }) ?? true;
      const filtered = this.getFilteredMetadata(name as SupportedProvider);
      return { ...filtered, available } as LLMProviderMetadata & { available: boolean };
    });
  }
}
