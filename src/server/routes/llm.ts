
import { Hono } from 'hono';
import type { LLMRequest, LLMMessage } from '../../types/llm';
import { envFromProcess, availableProviders, createProvider } from '../../llm/registry';
import '../../llm/providers/all'; // side-effect: registers providers

function validRole(x: any): x is 'system'|'user'|'assistant' { return x==='system'||x==='user'||x==='assistant' }

function parseBody(body: any): { ok: true; value: LLMRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object' };
  const msgs = Array.isArray(body.messages) ? body.messages : null;
  if (!msgs || msgs.length === 0) return { ok: false, error: 'messages[] is required' };
  for (const m of msgs) {
    if (!m || typeof m !== 'object') return { ok: false, error: 'Each message must be an object' };
    if (!validRole(m.role)) return { ok: false, error: `Invalid role '${m.role}'` };
    if (typeof m.content !== 'string' || m.content.length === 0) return { ok: false, error: 'message.content must be a non-empty string' };
  }
  const req: LLMRequest = {
    messages: msgs as LLMMessage[],
    ...(typeof body.model==='string'?{model:body.model}:{}) ,
    ...(typeof body.temperature==='number'?{temperature:body.temperature}:{}) ,
    ...(typeof body.maxTokens==='number'?{maxTokens:body.maxTokens}:{}) ,
    ...(Array.isArray(body.tools)?{tools:body.tools}:{}) ,
    ...(body.loggingMetadata && typeof body.loggingMetadata==='object'?{loggingMetadata:body.loggingMetadata}:{}) ,
  };
  return { ok:true, value:req };
}

export function createLLMRoutes() {
  const app = new Hono();
  const env = envFromProcess();

  app.get('/llm/providers', (c) => {
    return c.json(availableProviders(env));
  });

  app.post('/llm/complete', async (c) => {
    let body: any = null;
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const v = parseBody(body); if (!v.ok) return c.json({ error: v.error }, 400);
    try {
      const provider = createProvider(env, { provider: body.provider, model: body.model, config: { model: body.model, apiBase: env.BASE_URL ? `${env.BASE_URL}/api` : '/api' } });
      const result = await provider.complete(v.value);
      return c.json(result, 200);
    } catch (err: any) {
      return c.json({ error: 'ProviderError', message: String(err?.message || err) }, 502);
    }
  });

  return app;
}
