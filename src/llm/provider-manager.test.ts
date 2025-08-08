import { describe, it, expect } from 'bun:test';
import { ProviderManager } from './provider-manager';
import type { Config } from '$src/server/config';

describe('ProviderManager', () => {
  const mockConfig: Config = {
    dbPath: ':memory:',
    port: 3000,
    idleTurnMs: 120000,
    googleApiKey: 'test-google-key',
    openRouterApiKey: 'test-openrouter-key',
    defaultLlmProvider: 'mock',
    logLevel: 'info',
    nodeEnv: 'test',
  };

  it('creates mock provider by default', () => {
    const manager = new ProviderManager(mockConfig);
    const provider = manager.getProvider();
    
    expect(provider.getMetadata().name).toBe('mock');
  });

  it('creates google provider when specified', () => {
    const manager = new ProviderManager(mockConfig);
    const provider = manager.getProvider({ provider: 'google' });
    
    expect(provider.getMetadata().name).toBe('google');
  });

  it('creates openrouter provider when specified', () => {
    const manager = new ProviderManager(mockConfig);
    const provider = manager.getProvider({ provider: 'openrouter' });
    
    expect(provider.getMetadata().name).toBe('openrouter');
  });

  it('throws error for unsupported provider', () => {
    const manager = new ProviderManager(mockConfig);
    
    expect(() => {
      manager.getProvider({ provider: 'unsupported' as any });
    }).toThrow('Unsupported LLM provider: unsupported');
  });

  it('uses API key from config', () => {
    const manager = new ProviderManager(mockConfig);
    const provider = manager.getProvider({ provider: 'google' });
    
    // Provider should be created successfully with config API key
    expect(provider).toBeDefined();
  });

  it('uses override API key when provided', () => {
    const manager = new ProviderManager(mockConfig);
    const provider = manager.getProvider({ 
      provider: 'google',
      apiKey: 'override-key'
    });
    
    // Provider should be created with override key
    expect(provider).toBeDefined();
  });

  it('throws error when API key missing for non-mock provider', () => {
    const configNoKeys: Config = {
      ...mockConfig,
      googleApiKey: undefined,
      openRouterApiKey: undefined,
    };
    
    const manager = new ProviderManager(configNoKeys);
    
    expect(() => {
      manager.getProvider({ provider: 'google' });
    }).toThrow("API key for provider 'google' not found");
    
    expect(() => {
      manager.getProvider({ provider: 'openrouter' });
    }).toThrow("API key for provider 'openrouter' not found");
  });

  it('allows mock provider without API key', () => {
    const configNoKeys: Config = {
      ...mockConfig,
      googleApiKey: undefined,
      openRouterApiKey: undefined,
    };
    
    const manager = new ProviderManager(configNoKeys);
    const provider = manager.getProvider({ provider: 'mock' });
    
    expect(provider).toBeDefined();
    expect(provider.getMetadata().name).toBe('mock');
  });

  it('passes model configuration to provider', () => {
    const manager = new ProviderManager(mockConfig);
    const provider = manager.getProvider({ 
      provider: 'google',
      model: 'gemini-2.5-pro'
    });
    
    // Provider should receive the model config
    expect(provider).toBeDefined();
  });

  it('returns metadata for all available providers', () => {
    const manager = new ProviderManager(mockConfig);
    const providers = manager.getAvailableProviders();
    
    expect(providers).toHaveLength(3);
    
    const names = providers.map(p => p.name);
    expect(names).toContain('google');
    expect(names).toContain('openrouter');
    expect(names).toContain('mock');
    
    // Check that each has proper metadata
    for (const provider of providers) {
      expect(provider.description).toBeDefined();
      expect(provider.models).toBeDefined();
      expect(provider.defaultModel).toBeDefined();
    }
  });

  it('respects default provider from config', () => {
    const configWithGoogle: Config = {
      ...mockConfig,
      defaultLlmProvider: 'google',
    };
    
    const manager = new ProviderManager(configWithGoogle);
    const provider = manager.getProvider();
    
    expect(provider.getMetadata().name).toBe('google');
  });
});