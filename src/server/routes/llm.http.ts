import { Hono } from 'hono';
import { z } from 'zod';
import type { LLMProviderManager } from '$src/llm/provider-manager';
import type { LLMRequest, LLMResponse, SupportedProvider, LLMLoggingMetadata } from '$src/types/llm.types';

const LLMMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

const LLMToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.unknown()).default({}),
});

const LLMLoggingMetadataSchema = z.object({
  conversationId: z.string().optional(),
  agentName: z.string().optional(),
  turnNumber: z.number().optional(),
  scenarioId: z.string().optional(),
  stepDescriptor: z.string().optional(),
  requestId: z.string().optional(),
}).optional();

const LLMCompleteSchema = z.object({
  messages: z.array(LLMMessageSchema).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  tools: z.array(LLMToolSchema).optional(),
  loggingMetadata: LLMLoggingMetadataSchema,
  // Server-side override: which configured provider to use (no apiKey from clients)
  provider: z.enum(['google', 'openrouter', 'mock', 'browserside']).optional(),
});


export function createLLMRoutes(pm: LLMProviderManager) {
  const app = new Hono();

  // GET providers metadata
  app.get('/llm/providers', (c) => {
    const providers = pm.getAvailableProviders();
    return c.json(providers);
  });

  // POST completion (synchronous, non-streaming)
  app.post('/llm/complete', async (c) => {
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
        loggingMetadata: input.loggingMetadata || {},
        ...(input.model ? { model: input.model } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
      };

      // All providers handle their own logging - just pass through
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