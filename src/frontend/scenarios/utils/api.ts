// v3 API shim adapted to this project's /api backend
// Normalizes server responses (which return raw config JSON) to the
// scenario-builder's expected shape: { id, name, config, history? }

declare const __API_BASE__: string | undefined;
const API_BASE: string =
  (typeof window !== 'undefined' && (window as any).__APP_CONFIG__?.API_BASE) ||
  (typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : '/api');

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  // Inject X-Edit-Token if available (harmless if server ignores it)
  const token = (() => { try { return localStorage.getItem('scenario.edit.token') || ''; } catch { return ''; } })();
  const headers = new Headers(init?.headers || {});
  if (token) headers.set('X-Edit-Token', token);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  getBaseUrl() { return API_BASE.replace(/\/api$/, ''); },

  async getScenarios() {
    const list = await http<any[]>(`/scenarios`);
    // Server returns an array of raw configs; wrap them
    const normalized = (Array.isArray(list) ? list : []).map((cfg: any) => ({
      id: String(cfg?.metadata?.id || ''),
      name: String(cfg?.metadata?.title || cfg?.metadata?.id || 'Untitled'),
      config: cfg,
      history: [],
    }));
    return { success: true, data: { scenarios: normalized } };
  },

  async getScenario(id: string) {
    const cfg = await http<any>(`/scenarios/${encodeURIComponent(id)}`);
    const wrapped = {
      id: String(cfg?.metadata?.id || id),
      name: String(cfg?.metadata?.title || cfg?.metadata?.id || id),
      config: cfg,
      history: [],
    };
    return { success: true, data: wrapped };
  },

  async createScenario(name: string, config: any, history: any[] = []) {
    const cfg = await http<any>(`/scenarios`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, config, history })
    });
    const wrapped = {
      id: String(cfg?.metadata?.id || ''),
      name: String(cfg?.metadata?.title || cfg?.metadata?.id || name || 'Untitled'),
      config: cfg,
      history: Array.isArray(history) ? history : [],
    };
    return { success: true, data: wrapped };
  },

  async updateScenario(id: string, updates: any) {
    const cfg = await http<any>(`/scenarios/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates)
    });
    const wrapped = {
      id: String(cfg?.metadata?.id || id),
      name: String(cfg?.metadata?.title || cfg?.metadata?.id || id),
      config: cfg,
      history: [],
    };
    return { success: true, data: wrapped };
  },

  async updateScenarioConfig(id: string, config: any) {
    // Server supports PUT /scenarios/:id with { name?, config? }
    const cfg = await http<any>(`/scenarios/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config })
    });
    const wrapped = {
      id: String(cfg?.metadata?.id || id),
      name: String(cfg?.metadata?.title || cfg?.metadata?.id || id),
      config: cfg,
      history: [],
    };
    return { success: true, data: wrapped };
  },

  async deleteScenario(id: string) {
    const res = await http<any>(`/scenarios/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { success: true, data: res };
  },

  async restoreScenario(id: string) {
    const cfg = await http<any>(`/scenarios/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    const wrapped = {
      id: String(cfg?.metadata?.id || id),
      name: String(cfg?.metadata?.title || cfg?.metadata?.id || id),
      config: cfg,
      history: [],
    };
    return { success: true, data: wrapped };
  },

  async generateLLM(request: any, signal?: AbortSignal, scenarioId?: string) {
    // Add logging metadata for scenario editor calls
    const requestWithMetadata = {
      ...request,
      loggingMetadata: scenarioId ? {
        scenarioId,
        stepDescriptor: 'scenario_editor'
      } : undefined
    };
    const item = await http<any>(`/llm/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestWithMetadata), signal
    });
    return { success: true, data: item };
  },

  async getLLMConfig() {
    const providers = await http<any[]>(`/llm/providers`);
    return { success: true, data: { providers } };
  }
};
