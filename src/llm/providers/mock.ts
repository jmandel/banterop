
import { LLMProvider, type LLMProviderMetadata, type LLMRequest, type LLMResponse, type LLMProviderConfig } from '../../types/llm';
import { registerProvider, type ProviderDescriptor } from '../registry';
import { getLLMDebugLogger } from '../services/debug-logger';

class MockLLM extends LLMProvider {
  static getMetadata(): LLMProviderMetadata {
    return { name: 'mock', description: 'Mock LLM Provider', models: ['mock-model'], defaultModel: 'mock-model' };
  }
  getMetadata(): LLMProviderMetadata { return MockLLM.getMetadata() }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const logger = getLLMDebugLogger();
    const p = await logger.logRequest(req, req.loggingMetadata);
    const last = [...(req.messages||[])].reverse().find(m=>m.role==='user');
    const content = last ? `Mock response to: "${last.content}"` : 'Mock response with no user input';
    const res: LLMResponse = { content, usage:{ promptTokens:(req.messages||[]).reduce((n,m)=>n+m.content.length,0), completionTokens: content.length } };
    await logger.logResponse(res, p); return res;
  }
}

const desc: ProviderDescriptor = {
  name: 'mock',
  getMetadata: (_env) => MockLLM.getMetadata(),
  isAvailable: (_env) => true,
  create: (_env, cfg) => new MockLLM({ provider: 'mock', model: cfg?.model } as LLMProviderConfig),
};
registerProvider(desc);
export default desc;
