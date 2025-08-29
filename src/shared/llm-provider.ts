import type { LlmMessage, LlmProvider, LlmResponse } from './journal-types';

// Use same-origin backend by default
export const DEFAULT_CHITCHAT_ENDPOINT = '/api/llm/complete';
export const DEFAULT_CHITCHAT_MODEL = '@preset/chitchat';

export function makeChitchatProvider(endpoint?: string): LlmProvider {
  const ep = (endpoint || DEFAULT_CHITCHAT_ENDPOINT).trim();

  // Available models (dynamic from backend; fallback to curated)
  let AVAILABLE_MODELS = ['@preset/chitchat'];

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
      try {
        const base = (() => {
          try { const u = new URL(ep, window.location.origin); return u.origin; } catch { return ''; }
        })();
        const res = await fetch(base + '/api/llm/providers', { method: 'GET' });
        if (!res.ok) throw new Error(String(res.status));
        const arr: any[] = await res.json();
        const models = Array.from(new Set((arr || []).filter(p => p && p.available !== false).flatMap((p:any) => Array.isArray(p.models) ? p.models : []))).filter(Boolean) as string[];
        return models.length ? models : AVAILABLE_MODELS;
      } catch {
        return AVAILABLE_MODELS;
      }
    }
  };
}
