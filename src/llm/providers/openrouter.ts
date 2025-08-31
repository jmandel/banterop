
import OpenAI from 'openai';
import { LLMProvider, type LLMProviderMetadata, type LLMProviderConfig, type LLMRequest, type LLMResponse } from '../../types/llm';
import { registerProvider, type ProviderDescriptor } from '../registry';
import { getLLMDebugLogger } from '../services/debug-logger';

class OpenRouterLLM extends LLMProvider {
  private client: OpenAI;
  private providerRouting: Record<string, unknown>;
  constructor(cfg: LLMProviderConfig & { providerRouting?: Record<string, unknown> }) {
    super(cfg);
    if (!cfg.apiKey) throw new Error('OpenRouter API key is required');
    this.providerRouting = cfg.providerRouting || { ignore:['baseten'], allow_fallbacks:true, sort:'throughput' };
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: 'https://openrouter.ai/api/v1' });
  }
  static override getMetadata(): LLMProviderMetadata {
    // Advertise a single preset model; override via LLM_MODELS_OPENROUTER_INCLUDE if desired
    return { name:'openrouter', description:'OpenRouter AI Gateway', models:['@preset/banterop'], defaultModel:'@preset/banterop' };
  }
  override getMetadata(): LLMProviderMetadata { return OpenRouterLLM.getMetadata() }

  override async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = req.model || this.config.model || OpenRouterLLM.getMetadata().defaultModel;
    const logger = getLLMDebugLogger(); const p = await logger.logRequest(req, req.loggingMetadata);
    const completion:any = await (this.client as any).chat.completions.create({
      model, messages: req.messages,
      ...(req.temperature!=null?{temperature:req.temperature}:{}) ,
      ...(req.maxTokens!=null?{max_tokens:req.maxTokens}:{}) ,
      provider: (this.config as any).providerRouting
    });
    const choice = completion?.choices?.[0];
    if (!choice?.message?.content) throw new Error('No response from OpenRouter');
    const out: LLMResponse = { content: choice.message.content, ...(completion.usage?{usage:{promptTokens:completion.usage.prompt_tokens, completionTokens:completion.usage.completion_tokens}}:{}) };
    await logger.logResponse(out, p);
    return out;
  }
}

function parseJSON(s: string | undefined) { if (!s) return undefined; try { return JSON.parse(s) } catch { return undefined } }

const desc: ProviderDescriptor = {
  name: 'openrouter',
  getMetadata: (_env) => OpenRouterLLM.getMetadata(),
  isAvailable: (env) => !!env.OPENROUTER_API_KEY,
  create: (env, cfg) => {
    const apiKey = env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error(`API key for provider 'openrouter' not found`);
    const providerRouting = parseJSON(env.OPENROUTER_PROVIDER_CONFIG);
    return new OpenRouterLLM({ provider:'openrouter', apiKey, model: cfg?.model, providerRouting } as any);
  }
};
registerProvider(desc);
export default desc;
