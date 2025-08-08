import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { App } from '$src/server/app';
import { createLLMRoutes } from '$src/server/routes/llm.http';

describe('LLM HTTP routes', () => {
  let app: App;
  let server: any;
  let base: string;

  beforeEach(() => {
    app = new App({ dbPath: ':memory:', defaultLlmProvider: 'mock' as any });
    const hono = new Hono().route('/api', createLLMRoutes(app.providerManager));
    server = Bun.serve({ port: 0, fetch: hono.fetch });
    base = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
    server.stop();
    await app.shutdown();
  });

  it('lists providers', async () => {
    const res = await fetch(`${base}/api/llm/providers`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((p: any) => p.name === 'mock')).toBe(true);
  });

  it('completes with mock provider', async () => {
    const res = await fetch(`${base}/api/llm/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
        ],
        provider: 'mock',
      }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(typeof data.content).toBe('string');
  });

  it('validates request body', async () => {
    const res = await fetch(`${base}/api/llm/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }), // invalid
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid message role', async () => {
    const res = await fetch(`${base}/api/llm/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'invalid', content: 'test' }],
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('ValidationError');
  });

  it('rejects empty message content', async () => {
    const res = await fetch(`${base}/api/llm/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '' }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts optional parameters', async () => {
    const res = await fetch(`${base}/api/llm/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        maxTokens: 100,
        model: 'mock-model',  // Use a known model
      }),
    });
    expect(res.ok).toBe(true);
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await fetch(`${base}/api/llm/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Invalid JSON body');
  });

  it('returns 502 for provider errors', async () => {
    // Attempt to use a provider that requires API key without having one configured
    const appNoKey = new App({ dbPath: ':memory:', defaultLlmProvider: 'google' as any });
    const honoNoKey = new Hono().route('/api', createLLMRoutes(appNoKey.providerManager));
    const serverNoKey = Bun.serve({ port: 0, fetch: honoNoKey.fetch });
    
    try {
      const res = await fetch(`http://localhost:${serverNoKey.port}/api/llm/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          provider: 'google',
        }),
      });
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toBe('ProviderError');
    } finally {
      serverNoKey.stop();
      await appNoKey.shutdown();
    }
  });

  it('accepts tools in request', async () => {
    const res = await fetch(`${base}/api/llm/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'What is the weather?' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a location',
            parameters: { location: 'string' },
          },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(typeof data.content).toBe('string');
    // Mock provider doesn't return tool calls, but the request should be accepted
  });

  it('validates temperature range', async () => {
    const res = await fetch(`${base}/api/llm/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 3, // out of range
      }),
    });
    expect(res.status).toBe(400);
  });

  it('validates maxTokens is positive', async () => {
    const res = await fetch(`${base}/api/llm/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: -100,
      }),
    });
    expect(res.status).toBe(400);
  });
});