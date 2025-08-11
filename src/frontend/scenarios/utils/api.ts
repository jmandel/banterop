// v3 API shim that matches v2 scenario-builder expectations

declare const __API_BASE__: string | undefined;
const API_BASE: string =
  (typeof window !== 'undefined' && (window as any).__APP_CONFIG__?.API_BASE) ||
  (typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : 'http://localhost:3000/api');

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  getBaseUrl() { return API_BASE.replace(/\/api$/, ''); },

  async getScenarios() {
    const list = await http<any[]>(`/scenarios`);
    return { success: true, data: { scenarios: list } };
  },

  async getScenario(id: string) {
    const item = await http<any>(`/scenarios/${encodeURIComponent(id)}`);
    return { success: true, data: item };
  },

  async createScenario(name: string, config: any, history: any[] = []) {
    const item = await http<any>(`/scenarios`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, config, history })
    });
    return { success: true, data: item };
  },

  async updateScenario(id: string, updates: any) {
    const item = await http<any>(`/scenarios/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates)
    });
    return { success: true, data: item };
  },

  async updateScenarioConfig(id: string, config: any) {
    const item = await http<any>(`/scenarios/${encodeURIComponent(id)}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config)
    });
    return { success: true, data: item };
  },

  async deleteScenario(id: string) {
    const res = await http<any>(`/scenarios/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { success: true, data: res };
  },

  async generateLLM(request: any, signal?: AbortSignal) {
    const item = await http<any>(`/llm/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal
    });
    return { success: true, data: item };
  },

  async getLLMConfig() {
    const providers = await http<any[]>(`/llm/providers`);
    return { success: true, data: { providers } };
  }
};

