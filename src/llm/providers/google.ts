
import { GoogleGenAI } from '@google/genai';
import { LLMProvider, type LLMProviderMetadata, type LLMProviderConfig, type LLMRequest, type LLMResponse, type LLMMessage } from '../../types/llm';
import { registerProvider, type ProviderDescriptor } from '../registry';
import { getLLMDebugLogger } from '../services/debug-logger';

class GoogleLLM extends LLMProvider {
  private client: GoogleGenAI | null = null;
  constructor(cfg: LLMProviderConfig) { super(cfg); if (cfg.apiKey) this.client = new GoogleGenAI({ apiKey: cfg.apiKey }) }

  static getMetadata(): LLMProviderMetadata {
    return { name: 'google', description: 'Google Gemini via @google/genai', models: ['gemini-2.5-flash-lite','gemini-2.5-flash','gemini-2.5-pro'], defaultModel: 'gemini-2.5-flash-lite' };
  }
  getMetadata(): LLMProviderMetadata { return GoogleLLM.getMetadata() }

  private convert(msgs: LLMMessage[]) {
    const sys = msgs.find(m=>m.role==='system')?.content || '';
    const rest = msgs.filter(m=>m.role!=='system');
    if (rest.length===1 && rest[0]!.role==='user') return sys ? `${sys}\n\n${rest[0]!.content}` : rest[0]!.content;
    const arr:any[]=[]; if (sys) arr.push({ parts:[{text:sys}] });
    for (const m of rest) arr.push({ role: m.role==='assistant' ? 'model':'user', parts:[{text:m.content}] });
    return arr;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (!this.client) throw new Error('Google AI client not initialized - API key required');
    const model = req.model || this.config.model || GoogleLLM.getMetadata().defaultModel;
    const logger = getLLMDebugLogger(); const path = await logger.logRequest(req, req.loggingMetadata);
    const contents = this.convert(req.messages||[]);
    const resp:any = await (this.client as any).models.generateContent({ model, contents, config: { ...(req.temperature!=null?{temperature:req.temperature}:{}) , ...(req.maxTokens!=null?{maxOutputTokens:req.maxTokens}:{}) } });
    const text = String(resp?.text || '');
    const out: LLMResponse = { content: text };
    await logger.logResponse(out, path); return out;
  }
}

const desc: ProviderDescriptor = {
  name: 'google',
  getMetadata: (_env) => GoogleLLM.getMetadata(),
  isAvailable: (env) => !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
  create: (env, cfg) => {
    const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error(`API key for provider 'google' not found`);
    return new GoogleLLM({ provider:'google', apiKey, model: cfg?.model } as LLMProviderConfig);
  }
};
registerProvider(desc);
export default desc;
