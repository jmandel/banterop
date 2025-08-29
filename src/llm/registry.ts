
import type { LLMProvider, LLMProviderMetadata, LLMProviderConfig, SupportedProvider } from '../types/llm';

export type Env = Record<string, any>;

export type ProviderDescriptor = {
  name: SupportedProvider;
  getMetadata(env: Env): LLMProviderMetadata;   // base metadata (or env-filtered if provider prefers)
  isAvailable(env: Env): boolean;               // provider decides its availability
  create(env: Env, cfg?: Partial<LLMProviderConfig>): LLMProvider; // provider builds itself (reads its own env keys)
  canServeModel?: (model: string, env: Env) => boolean; // optional; default uses metadata.models
};

const REGISTRY = new Map<string, ProviderDescriptor>();

export function registerProvider(desc: ProviderDescriptor) {
  REGISTRY.set(desc.name, desc);
}

export function getProvider(name: string): ProviderDescriptor | undefined { return REGISTRY.get(name) }
export function listProviderNames(): string[] { return Array.from(REGISTRY.keys()) }

function applyInclude(meta: LLMProviderMetadata, providerName: string, env: Env): LLMProviderMetadata {
  const key = `LLM_MODELS_${providerName.toUpperCase()}_INCLUDE`;
  const include = String(env[key] || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!include.length) return meta;
  return { ...meta, models: include, defaultModel: include[0] || '' };
}

export function availableProviders(env: Env): (LLMProviderMetadata & { available: boolean })[] {
  const out: (LLMProviderMetadata & { available: boolean })[] = [];
  for (const [name, desc] of REGISTRY) {
    const base = desc.getMetadata(env);
    const meta = applyInclude(base, name, env);
    const available = !!desc.isAvailable(env);
    out.push({ ...meta, available });
  }
  return out;
}

export function resolveProviderByModel(model: string, env: Env): ProviderDescriptor | null {
  for (const [name, desc] of REGISTRY) {
    const meta = applyInclude(desc.getMetadata(env), name, env);
    const models = meta.models || [];
    const ok = (models.includes(model)) || models.some(m => m.endsWith('/'+model) || m === `${meta.name}/${model}`);
    if (ok) return desc;
    if (desc.canServeModel && desc.canServeModel(model, env)) return desc;
  }
  return null;
}

export function createProvider(env: Env, opts?: { provider?: SupportedProvider; model?: string; config?: Partial<LLMProviderConfig> }): LLMProvider {
  const requestedProvider = opts?.provider as string | undefined;
  const requestedModel = opts?.model;

  // 1) If an explicit provider was requested and is registered, honor it
  if (requestedProvider) {
    const byName = REGISTRY.get(requestedProvider);
    if (byName) return byName.create(env, { ...(opts?.config || {}), model: requestedModel });
  }

  // 2) If a model was requested, attempt to resolve a provider that serves it
  if (requestedModel) {
    const byModel = resolveProviderByModel(requestedModel, env);
    if (byModel) return byModel.create(env, { ...(opts?.config || {}), model: requestedModel });
  }

  // 3) Fall back to DEFAULT_LLM_PROVIDER if configured, else mock
  const defaultName = (env.DEFAULT_LLM_PROVIDER as string | undefined) || 'mock';
  const byDefault = REGISTRY.get(defaultName);
  if (byDefault) return byDefault.create(env, { ...(opts?.config || {}), model: requestedModel });

  const fallback = REGISTRY.get('mock');
  if (!fallback) throw new Error('No providers registered');
  return fallback.create(env, { ...(opts?.config || {}), model: requestedModel });
}

export function envFromProcess(): Env { return process.env as any; }
