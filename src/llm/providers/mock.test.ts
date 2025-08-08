import { describe, it, expect } from 'bun:test';
import { MockLLMProvider } from './mock';

describe('MockLLMProvider', () => {
  it('returns metadata correctly', () => {
    const provider = new MockLLMProvider({ provider: 'mock' });
    const metadata = provider.getMetadata();
    
    expect(metadata.name).toBe('mock');
    expect(metadata.description).toBe('Mock LLM Provider for testing');
    expect(metadata.models).toEqual(['mock-model']);
    expect(metadata.defaultModel).toBe('mock-model');
  });

  it('echoes user message in response', async () => {
    const provider = new MockLLMProvider({ provider: 'mock' });
    
    const response = await provider.complete({
      messages: [
        { role: 'system', content: 'You are a test assistant' },
        { role: 'user', content: 'Hello, mock!' }
      ]
    });
    
    expect(response.content).toBe('Mock response to: "Hello, mock!"');
    expect(response.usage).toBeDefined();
    expect(response.usage?.promptTokens).toBeGreaterThan(0);
    expect(response.usage?.completionTokens).toBeGreaterThan(0);
  });

  it('handles conversation with multiple messages', async () => {
    const provider = new MockLLMProvider({ provider: 'mock' });
    
    const response = await provider.complete({
      messages: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Second question' }
      ]
    });
    
    expect(response.content).toBe('Mock response to: "Second question"');
  });

  it('handles empty message list', async () => {
    const provider = new MockLLMProvider({ provider: 'mock' });
    
    const response = await provider.complete({
      messages: []
    });
    
    expect(response.content).toBe('Mock response with no user input');
  });

  it('respects temperature and maxTokens parameters', async () => {
    const provider = new MockLLMProvider({ provider: 'mock' });
    
    const response = await provider.complete({
      messages: [{ role: 'user', content: 'Test' }],
      temperature: 0.5,
      maxTokens: 100
    });
    
    // Mock provider doesn't actually use these, but should accept them
    expect(response.content).toBeDefined();
  });
});