
import { LLMProvider, type LLMProviderMetadata, type LLMProviderConfig, type LLMRequest, type LLMResponse } from '../../types/llm';
import { registerProvider, type ProviderDescriptor } from '../registry';

class BrowsersideLLM extends LLMProvider {
  private apiBase: string;
  constructor(cfg: LLMProviderConfig & { apiBase?: string }) {
    super(cfg);
    const base = cfg.apiBase || '';
    this.apiBase = base.endsWith('/api') ? base : (base ? base + '/api' : '');
  }
  static override getMetadata(): LLMProviderMetadata {
    return { name:'browserside', description:'Browser proxy to server /api/llm', models:[], defaultModel:'' };
  }
  override getMetadata(): LLMProviderMetadata { return BrowsersideLLM.getMetadata() }

  override async complete(req: LLMRequest): Promise<LLMResponse> {
    const res = await fetch(`${this.apiBase}/llm/complete`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(req) });
    if (!res.ok) {
      const e = await res.json().catch(()=>({}));
      throw new Error(e?.message || 'Server LLM API error');
    }
    return await res.json();
  }
}

const desc: ProviderDescriptor = {
  name: 'browserside',
  getMetadata: (_env) => BrowsersideLLM.getMetadata(),
  isAvailable: (_env) => true,
  create: (env, cfg) => new BrowsersideLLM({ provider:'browserside', apiBase: cfg?.apiBase || (env.BASE_URL ? `${env.BASE_URL}/api` : '/api') } as any)
};
registerProvider(desc);
export default desc;
