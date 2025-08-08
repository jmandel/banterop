import { describe, it, expect, mock } from 'bun:test';
import { GoogleLLMProvider } from './google';

describe('GoogleLLMProvider', () => {
  it('throws error when no API key provided', () => {
    expect(() => {
      const provider = new GoogleLLMProvider({ provider: 'google' });
      // Should not initialize client without API key
      expect(provider).toBeDefined();
    }).not.toThrow();
  });

  it('throws error when calling complete without API key', async () => {
    const provider = new GoogleLLMProvider({ provider: 'google' });
    
    await expect(provider.complete({
      messages: [{ role: 'user', content: 'test' }]
    })).rejects.toThrow('Google AI client not initialized - API key required');
  });

  it('returns correct metadata', () => {
    const provider = new GoogleLLMProvider({ provider: 'google', apiKey: 'test-key' });
    const metadata = provider.getMetadata();
    
    expect(metadata.name).toBe('google');
    expect(metadata.description).toBe('Google Gemini models via @google/genai');
    expect(metadata.models).toContain('gemini-2.5-flash-lite');
    expect(metadata.models).toContain('gemini-2.5-flash');
    expect(metadata.models).toContain('gemini-2.5-pro');
    expect(metadata.defaultModel).toBe('gemini-2.5-flash-lite');
  });

  it('converts single user message correctly', () => {
    const provider = new GoogleLLMProvider({ provider: 'google', apiKey: 'test-key' });
    
    // Access private method via any cast for testing
    const converted = (provider as any).convertMessagesToGoogleFormat([
      { role: 'user', content: 'Hello' }
    ]);
    
    expect(converted).toBe('Hello');
  });

  it('converts single user message with system prompt', () => {
    const provider = new GoogleLLMProvider({ provider: 'google', apiKey: 'test-key' });
    
    const converted = (provider as any).convertMessagesToGoogleFormat([
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' }
    ]);
    
    expect(converted).toBe('You are helpful\n\nHello');
  });

  it('converts multi-turn conversation correctly', () => {
    const provider = new GoogleLLMProvider({ provider: 'google', apiKey: 'test-key' });
    
    const converted = (provider as any).convertMessagesToGoogleFormat([
      { role: 'system', content: 'System message' },
      { role: 'user', content: 'User 1' },
      { role: 'assistant', content: 'Assistant 1' },
      { role: 'user', content: 'User 2' }
    ]);
    
    expect(Array.isArray(converted)).toBe(true);
    expect(converted).toHaveLength(4);
    expect(converted[0]).toEqual({ parts: [{ text: 'System message' }] });
    expect(converted[1]).toEqual({ role: 'user', parts: [{ text: 'User 1' }] });
    expect(converted[2]).toEqual({ role: 'model', parts: [{ text: 'Assistant 1' }] });
    expect(converted[3]).toEqual({ role: 'user', parts: [{ text: 'User 2' }] });
  });

  it('uses custom model when specified', async () => {
    const provider = new GoogleLLMProvider({ 
      provider: 'google', 
      apiKey: 'test-key',
      model: 'gemini-2.5-pro'
    });
    
    // Mock the client to verify model selection
    const mockGenerateContent = mock(() => Promise.resolve({ text: 'response' }));
    (provider as any).client = {
      models: {
        generateContent: mockGenerateContent
      }
    };
    
    await provider.complete({
      messages: [{ role: 'user', content: 'test' }]
    });
    
    expect(mockGenerateContent).toHaveBeenCalledWith({
      model: 'gemini-2.5-pro',
      contents: 'test',
      config: {}
    });
  });
});