import { LLMDrafterPlanner } from './planners/llm-drafter';
import { SimpleDemoPlanner } from './planners/simple-demo';

export type PlannerRegistryEntry = {
  id: string;
  name: string;
  defaults: any;
  toHarnessCfg: (applied?: any) => any;
  summary?: (cfg?: any) => string;
};

export const PlannerRegistry: Record<string, PlannerRegistryEntry> = {
  'llm-drafter': {
    id: 'llm-drafter',
    name: 'LLM Drafter',
    defaults: { endpoint: undefined, model: 'openai/gpt-oss-120b:nitro', temperature: 0.2, systemAppend: '', targetWords: 0 },
    toHarnessCfg: (applied?: any) => ({
      endpoint: applied?.endpoint,
      model: 'openai/gpt-oss-120b:nitro',
      temperature: typeof applied?.temperature === 'number' ? applied.temperature : 0.2,
      systemAppend: String(applied?.systemAppend || ''),
      targetWords: Number(applied?.targetWords || 0),
    }),
    summary: (cfg?: any) => {
      const n = Number(cfg?.targetWords || 0);
      const hasAppend = !!String(cfg?.systemAppend || '').trim();
      const parts: string[] = [];
      parts.push(n > 0 ? `Target Word Count: ~${n}` : 'Target Word Count: none');
      parts.push(`System prompt: ${hasAppend ? 'customized' : 'default'}`);
      return parts.join(' • ');
    },
  },
  'simple-demo': {
    id: 'simple-demo',
    name: 'Simple Demo Planner',
    defaults: { mode: 'suggest' },
    toHarnessCfg: (applied?: any) => ({ mode: (applied?.mode || 'suggest') }),
    summary: (cfg?: any) => `mode: ${cfg?.mode || 'suggest'}`,
  },
};

export function resolvePlanner(id: string) {
  if (id === 'llm-drafter') return LLMDrafterPlanner;
  if (id === 'simple-demo') return SimpleDemoPlanner;
  return SimpleDemoPlanner;
}
