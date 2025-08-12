import { Hono } from 'hono';
import { z } from 'zod';
import type { LLMProviderManager } from '$src/llm/provider-manager';
import type { LLMRequest, LLMResponse, SupportedProvider } from '$src/types/llm.types';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
        ...(input.model ? { model: input.model } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
      };

      // Optional debug logging of request/response to files
      const debugFlag = (process.env.DEBUG_LLM_REQUESTS || '').toString().trim();
      const debugEnabled = debugFlag && !/^0|false|off$/i.test(debugFlag);
      let basePath: string | null = null;
      if (debugEnabled) {
        const debugDir = process.env.LLM_DEBUG_DIR || '/data/llm-debug';
        if (!existsSync(debugDir)) {
          try { mkdirSync(debugDir, { recursive: true }); } catch {}
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const rand = Math.random().toString(36).slice(2, 8);
        basePath = join(debugDir, `${stamp}-${rand}`);
        const reqText = (input.messages || [])
          .map((m) => `${m.role}:\n${m.content}`)
          .join('\n\n');
        try { await Bun.write(`${basePath}.request.txt`, reqText); } catch {}
      }

      const result: LLMResponse = await provider.complete(req);

      if (debugEnabled && basePath) {
        const resText = (result?.content ?? '').toString();
        try { await Bun.write(`${basePath}.response.txt`, resText); } catch {}
      }
      return c.json(result, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Provider error';
      // Provider/network/API error -> 502
      return c.json({ error: 'ProviderError', message }, 502);
    }
  });

  return app;
}