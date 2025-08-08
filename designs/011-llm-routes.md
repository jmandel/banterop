Short answer
- No, we don’t currently expose LLM endpoints.
- We will add a small, stateless HTTP LLM API, separate from conversation orchestration:
  - GET /api/llm/providers
  - POST /api/llm/complete (synchronous, non-streaming)
- It uses ProviderManager and server-held API keys. We do not allow API keys via request. We do not stream tokens. This keeps it safe, deterministic, and easy to consume.

Self-contained dev plan (locked choices)

What and why
- Add a minimal HTTP LLM façade for direct completions that are not part of a conversation. This is useful for admin tools, diagnostics, and builder workflows.
- Keep it strictly synchronous and stateless: no streaming, no server-side tool execution, no conversation persistence.
- Keys never come from the request. The server uses ProviderManager + config.
- Validate requests with zod. Return 400 on validation errors, 502 on provider failures.

API surface (final)
- GET /api/llm/providers
  - Returns list of available providers and their metadata.
- POST /api/llm/complete
  - Body: LLMRequest plus optional provider/model overrides.
  - Returns LLMResponse.
- No other LLM routes for v1. No streaming (SSE) for v1.

Request/response contracts
- Request body for POST /api/llm/complete:
  - messages: LLMMessage[]
  - model?: string
  - temperature?: number
  - maxTokens?: number
  - tools?: LLMTool[]
  - provider?: 'google' | 'openrouter' | 'mock' (optional override)
- Response:
  - content: string
  - toolCalls?: [...]
  - usage?: { promptTokens, completionTokens }

Implementation steps

1) Add llm routes
Create file: src/server/routes/llm.http.ts

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { ProviderManager } from '$src/llm/provider-manager';
import type { LLMRequest, LLMResponse, SupportedProvider } from '$src/types/llm.types';

const LLMMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

const LLMToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.unknown()).default({}),
});

const LLMCompleteSchema = z.object({
  messages: z.array(LLMMessageSchema).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  tools: z.array(LLMToolSchema).optional(),
  // Server-side override: which configured provider to use (no apiKey from clients)
  provider: z.enum(['google', 'openrouter', 'mock']).optional(),
});

export function createLLMRoutes(pm: ProviderManager) {
  const app = new Hono();

  // GET providers metadata
  app.get('/api/llm/providers', (c) => {
    const providers = pm.getAvailableProviders();
    return c.json(providers);
  });

  // POST completion (synchronous, non-streaming)
  app.post('/api/llm/complete', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = LLMCompleteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'ValidationError', details: parsed.error.flatten() }, 400);
    }

    const input = parsed.data;
    try {
      const provider = pm.getProvider({
        ...(input.provider ? { provider: input.provider as SupportedProvider } : {}),
        ...(input.model ? { model: input.model } : {}),
      });

      // Build LLMRequest for the provider
      const req: LLMRequest = {
        messages: input.messages,
        ...(input.model ? { model: input.model } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
      };

      const result: LLMResponse = await provider.complete(req);
      return c.json(result, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Provider error';
      // Provider/network/API error -> 502
      return c.json({ error: 'ProviderError', message }, 502);
    }
  });

  return app;
}
```

2) Mount the LLM routes
Update file: src/server/index.ts

```ts
import { Hono } from 'hono';
import { App } from './app';
import { createWebSocketServer, websocket } from './ws/jsonrpc.server';
import { createScenarioRoutes } from './routes/scenarios.http';
import { createAttachmentRoutes } from './routes/attachments.http';
import { createLLMRoutes } from './routes/llm.http';

const appInstance = new App();

const server = new Hono();

// HTTP: scenarios CRUD
server.route('/api/scenarios', createScenarioRoutes(appInstance.orchestrator.storage.scenarios));

// HTTP: attachments metadata + content
server.route('/', createAttachmentRoutes(appInstance.orchestrator));

// HTTP: LLM sync completion + providers list
server.route('/', createLLMRoutes(appInstance.providerManager));

// WS: conversations and streaming
server.route('/', createWebSocketServer(appInstance.orchestrator));

// Health
server.get('/health', (c) => c.json({ ok: true }));

process.on('SIGTERM', async () => {
  await appInstance.shutdown();
  process.exit(0);
});

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: server.fetch,
  websocket,
};
```

3) Lock in behavior and constraints
- No streaming endpoint for LLM in v1. POST /api/llm/complete is synchronous only.
- No API key acceptance from clients. The route only accepts provider and model overrides; keys come from server config.
- We do not persist LLM requests/responses; this route is stateless.
- We do not execute tool calls in this route; toolCalls from providers are returned to the caller as-is.

4) Tests
Add tests to ensure correctness and stability.

New file: src/server/routes/llm.http.test.ts

```ts
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
    const hono = new Hono().route('/', createLLMRoutes(app.providerManager));
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
});
```

5) Minimal docs (developer notes)
- POST /api/llm/complete does not stream. If you need streaming tokens, add a separate SSE route in a future iteration; don’t overload this one.
- Use provider to select a configured provider (mock/google/openrouter); model can override the default for that provider.
- For conversation-bound LLM calls, prefer internal agents (AssistantAgent, ScenarioDrivenAgent) that go through the Orchestrator and WS flow; this LLM HTTP is for ad-hoc calls and tools.

Security and ops
- Keys are loaded via ConfigManager and never accepted from clients.
- 400 for validation errors; 502 for provider errors.
- Keep logs minimal: method, provider, model; do not log message contents in production if privacy-sensitive.

Out of scope (intentionally)
- SSE/token streaming
- Tool execution/oracle on this HTTP route
- Persisting LLM calls
- User-supplied API keys

This gives you a clean HTTP surface for quick LLM completions and provider discovery, while keeping conversation workflows on WS where ordering and replay matter.
