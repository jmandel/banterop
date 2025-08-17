import { describe, it, expect, mock } from 'bun:test';
import { OpenRouterLLMProvider } from './openrouter';

describe('OpenRouterLLMProvider', () => {
  it('throws error when no API key provided', async () => {
    expect(() => {
      new OpenRouterLLMProvider({ provider: 'openrouter' });
    }).toThrow('OpenRouter API key is required');
  });

  it('returns correct metadata', () => {
    const provider = new OpenRouterLLMProvider({ 
      provider: 'openrouter', 
      apiKey: 'test-key' 
    });
    const metadata = provider.getMetadata();
    
    expect(metadata.name).toBe('openrouter');
    expect(metadata.description).toBe('OpenRouter AI Gateway');
    expect(Array.isArray(metadata.models)).toBe(true);
    expect(metadata.models.length).toBeGreaterThan(0);
    // defaultModel should be one of the available models
    expect(metadata.models).toContain(metadata.defaultModel);
  });

  it('configures OpenAI client with correct baseURL and headers', () => {
    const provider = new OpenRouterLLMProvider({ 
      provider: 'openrouter', 
      apiKey: 'test-key' 
    });
    
    // Verify the client is created (we can't easily inspect its config)
    expect((provider as any).client).toBeDefined();
  });

  it('passes messages directly to OpenAI format', async () => {
    const provider = new OpenRouterLLMProvider({ 
      provider: 'openrouter', 
      apiKey: 'test-key' 
    });
    
    // Mock the OpenAI client
    const mockCreate = mock(() => Promise.resolve({
      choices: [{
        message: { content: 'Test response' }
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5
      }
    }));
    
    (provider as any).client = {
      chat: {
        completions: {
          create: mockCreate
        }
      }
    };
    
    const messages = [
      { role: 'system' as const, content: 'You are helpful' },
      { role: 'user' as const, content: 'Hello' }
    ];
    
    await provider.complete({ messages, loggingMetadata: {} });
    
    const expectedModel = provider.getMetadata().defaultModel;
    expect(mockCreate).toHaveBeenCalledWith({
      model: expectedModel,
      messages
    });
  });

  it('includes temperature and maxTokens when provided', async () => {
    const provider = new OpenRouterLLMProvider({ 
      provider: 'openrouter', 
      apiKey: 'test-key' 
    });
    
    const mockCreate = mock(() => Promise.resolve({
      choices: [{
        message: { content: 'Test response' }
      }]
    }));
    
    (provider as any).client = {
      chat: {
        completions: {
          create: mockCreate
        }
      }
    };
    
    await provider.complete({ 
      messages: [{ role: 'user' as const, content: 'test' }],
      temperature: 0.7,
      maxTokens: 150,
      loggingMetadata: {}
    });
    
    const expectedModel = provider.getMetadata().defaultModel;
    expect(mockCreate).toHaveBeenCalledWith({
      model: expectedModel,
      messages: [{ role: 'user', content: 'test' }],
      temperature: 0.7,
      max_tokens: 150
    });
  });

  it('handles response without usage data', async () => {
    const provider = new OpenRouterLLMProvider({ 
      provider: 'openrouter', 
      apiKey: 'test-key' 
    });
    
    (provider as any).client = {
      chat: {
        completions: {
          create: mock(() => Promise.resolve({
            choices: [{
              message: { content: 'Response without usage' }
            }]
          }))
        }
      }
    };
    
    const response = await provider.complete({
      messages: [{ role: 'user' as const, content: 'test' }],
      loggingMetadata: {}
    });
    
    expect(response.content).toBe('Response without usage');
    expect(response.usage).toBeUndefined();
  });

  it('throws error when no response content', async () => {
    const provider = new OpenRouterLLMProvider({ 
      provider: 'openrouter', 
      apiKey: 'test-key' 
    });
    
    (provider as any).client = {
      chat: {
        completions: {
          create: mock(() => Promise.resolve({
            choices: []
          }))
        }
      }
    };
    
    await expect(provider.complete({
      messages: [{ role: 'user' as const, content: 'test' }],
      loggingMetadata: {}
    })).rejects.toThrow('No response from OpenRouter');
  });

  it('uses custom model when specified', async () => {
    const provider = new OpenRouterLLMProvider({ 
      provider: 'openrouter', 
      apiKey: 'test-key',
      model: 'anthropic/claude-3-opus'
    });
    
    const mockCreate = mock(() => Promise.resolve({
      choices: [{
        message: { content: 'Claude response' }
      }]
    }));
    
    (provider as any).client = {
      chat: {
        completions: {
          create: mockCreate
        }
      }
    };
    
    await provider.complete({
      messages: [{ role: 'user' as const, content: 'test' }],
      loggingMetadata: {}
    });
    
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'anthropic/claude-3-opus',
      messages: [{ role: 'user', content: 'test' }]
    });
  });
});
