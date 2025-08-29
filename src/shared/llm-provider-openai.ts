import type { LlmMessage, LlmProvider, LlmResponse } from './journal-types';

export type OpenAICompatibleOpts = {
  baseUrl: string; // e.g., https://api.openai.com/v1 or any OpenAI-compatible /v1
  apiKey: string;  // Bearer token
};

function toChatMessages(msgs: LlmMessage[]): Array<{ role: 'system'|'user'|'assistant'; content: string }> {
  return msgs.map(m => ({ role: m.role, content: m.content }));
}

export function makeOpenAICompatibleProvider(opts: OpenAICompatibleOpts): LlmProvider {
  const base = String(opts.baseUrl || '').replace(/\/$/, '');
  const endpoint = base + '/chat/completions';
  const key = String(opts.apiKey || '').trim();

  async function chat(req: { model?: string; messages: LlmMessage[]; temperature?: number; maxTokens?: number; signal?: AbortSignal }): Promise<LlmResponse> {
    if (!base || !key) throw new Error('Missing OpenAI-compatible base URL or API key');
    const body = JSON.stringify({
      model: req.model,
      messages: toChatMessages(req.messages),
      temperature: typeof req.temperature === 'number' ? req.temperature : 0.2,
      max_tokens: typeof req.maxTokens === 'number' ? req.maxTokens : undefined,
      stream: false,
    });
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
      },
      body,
      signal: req.signal,
    });
    if (!res.ok) {
      let t = '';
      try { t = await res.text(); } catch {}
      throw new Error(`OpenAI-compatible HTTP ${res.status}: ${t.slice(0, 400)}`);
    }
    const j: any = await res.json();
    const text = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text ?? '';
    return { text: String(text || '').trim() };
  }

  return {
    chat,
    async listModels() { return []; },
  };
}

