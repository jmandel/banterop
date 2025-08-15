type Cfg = { apiBase: string; wsUrl: string };
const cfg: Cfg = (window as any).DEBUG_CONFIG ?? { apiBase: '/api/debug', wsUrl: `${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/ws` };

export const API = {
  cfg,
  async llmProviders() {
    const r = await fetch(`/api/llm/providers`);
    if (!r.ok) throw new Error('providers');
    return r.json() as Promise<Array<{ name: string; models: string[]; defaultModel: string; available?: boolean }>>;
  },
  async llmComplete(body: {
    messages: Array<{ role: 'system'|'user'|'assistant'; content: string }>;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    provider?: 'google'|'openrouter'|'mock'|'browserside';
  }) {
    const r = await fetch(`/api/llm/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('llm');
    return r.json() as Promise<{ content: string }>;
  },
  async overview() {
    const r = await fetch(`${cfg.apiBase}/overview`); if (!r.ok) throw new Error('overview');
    return r.json();
  },
  async listConversations(status?: 'active'|'completed') {
    const q = status ? `?status=${status}` : '';
    const r = await fetch(`${cfg.apiBase}/conversations${q}`); if (!r.ok) throw new Error('list');
    return r.json();
  },
  async snapshot(id: number) {
    const r = await fetch(`${cfg.apiBase}/conversations/${id}/snapshot`); if (!r.ok) throw new Error('snapshot');
    return r.json();
  },
  async events(id: number, afterSeq?: number, limit = 200) {
    const qs = new URLSearchParams(); if (afterSeq) qs.set('afterSeq', String(afterSeq)); if (limit) qs.set('limit', String(limit));
    const r = await fetch(`${cfg.apiBase}/conversations/${id}/events?${qs}`); if (!r.ok) throw new Error('events');
    return r.json();
  },
  async scenarios() {
    const r = await fetch(`${cfg.apiBase}/scenarios`); if (!r.ok) throw new Error('scenarios');
    return r.json();
  },
  async runners() {
    const r = await fetch(`${cfg.apiBase}/runners`); if (!r.ok) throw new Error('runners');
    return r.json();
  },
  attachmentMeta(id: string) { return fetch(`${cfg.apiBase}/attachments/${id}`).then(r => r.json()); },
  attachmentContentUrl(id: string) { return `${cfg.apiBase}/attachments/${id}/content`; },
  async sqlRead(sql: string, params?: Record<string, string|number|null|undefined>) {
    const r = await fetch(`${cfg.apiBase}/sql/read`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ sql, ...(params ? { params } : {}) }) });
    return r.json();
  }
};
