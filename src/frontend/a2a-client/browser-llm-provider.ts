import { LLMProvider, type LLMRequest, type LLMResponse, type LLMProviderConfig, type LLMProviderMetadata } from '$src/types/llm.types';

function apiBase(): string {
  const win = (globalThis as any)?.window;
  const fromWin = win?.__APP_CONFIG__?.API_BASE;
  return typeof fromWin === 'string' && fromWin ? fromWin : 'http://localhost:3000/api';
}

export class BrowserLLMProvider extends LLMProvider {
  constructor(cfg: LLMProviderConfig & { defaultModel?: string }) {
    super(cfg);
  }

  static getMetadata(): LLMProviderMetadata {
    return {
      name: 'browserside',
      description: 'Browser-side LLM provider proxying to server /llm/complete',
      models: [],
      defaultModel: ''
    };
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body: any = {
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      ...(request.model ? { model: request.model } : {}),
    };
    const url = `${apiBase()}/llm/complete`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `LLM error: ${res.status}`;
      try { const j = await res.json(); if (j?.message) msg = String(j.message); } catch {}
      throw new Error(msg);
    }
    const j = await res.json();
    return { content: String(j?.content ?? '') } as LLMResponse;
  }
}
