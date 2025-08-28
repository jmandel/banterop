import type { LlmMessage, LlmProvider, LlmResponse } from './journal-types';

export const DEFAULT_CHITCHAT_ENDPOINT = 'https://chitchat.fhir.me/api/llm/complete';
export const DEFAULT_CHITCHAT_MODEL = 'openai/gpt-oss-120b:nitro';

export function makeChitchatProvider(endpoint?: string): LlmProvider {
  const ep = (endpoint || DEFAULT_CHITCHAT_ENDPOINT).trim();

  // Available models (simplified for now)
  const AVAILABLE_MODELS = [
    'openai/gpt-oss-120b:nitro'
  ];

  return {
    async chat(req: { model?: string; messages: LlmMessage[]; temperature?: number; maxTokens?: number; signal?: AbortSignal }): Promise<LlmResponse> {
      // Single attempt only; retries are handled by a shared wrapper
      const body = JSON.stringify({
        model: req.model || DEFAULT_CHITCHAT_MODEL,
        messages: req.messages,
        temperature: typeof req.temperature === 'number' ? req.temperature : 0.2,
        maxTokens: typeof req.maxTokens === 'number' ? req.maxTokens : undefined,
      });

      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: req.signal
      });

      if (!res.ok) {
        const msg = `LLM HTTP ${res.status}`;
        try { const t = await res.text(); throw new Error(`${msg}: ${t?.slice(0,200) || ''}`); }
        catch (e:any) { throw (e instanceof Error ? e : new Error(msg)); }
      }

      const j: any = await res.json();
      const text =
        (j && typeof j === 'object' && j.result && typeof j.result.text === 'string' && j.result.text)
        || (j && typeof j === 'object' && j.result && typeof j.result.content === 'string' && j.result.content)
        || (j && Array.isArray(j.choices) && j.choices[0]?.message?.content)
        || (typeof j.text === 'string' ? j.text : null)
        || (typeof j.content === 'string' ? j.content : null)
        || '';
      const cleaned = String(text).trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
      return { text: cleaned };
    },

    async listModels(): Promise<string[]> {
      // Return the common models available in the system
      // In a real implementation, this might query the endpoint for available models
      return AVAILABLE_MODELS;
    }
  };
}
