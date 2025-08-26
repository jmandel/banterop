import { LLMDrafterPlanner } from './planners/llm-drafter';
// Attach config companions (side-effect imports)
import './planners/llm-drafter-config';
import { SimpleDemoPlanner } from './planners/simple-demo';
import { ScenarioPlannerV03 } from './planners/scenario-planner';
import './planners/scenario-config';

export type PlannerRegistryEntry = {
  id: string;
  name: string;
  toHarnessCfg: (applied?: any) => any;
};

export const PlannerRegistry: Record<string, PlannerRegistryEntry> = {
  'llm-drafter': {
    id: 'llm-drafter',
    name: 'LLM Drafter',
    toHarnessCfg: (applied?: any) => ({
      endpoint: applied?.endpoint,
      model: 'openai/gpt-oss-120b:nitro',
      temperature: typeof applied?.temperature === 'number' ? applied.temperature : 0.2,
      systemAppend: String(applied?.systemAppend || ''),
      targetWords: Number(applied?.targetWords || 0),
    }),
  },
  'scenario-v0.3': {
    id: 'scenario-v0.3',
    name: 'Scenario Planner',
    toHarnessCfg: (applied?: any) => ({
      scenario: applied?.resolvedScenario,
      includeWhy: applied?.includeWhy !== false,
      allowInitiation: !!applied?.allowInitiation,
      model: String(applied?.model || ''),
    }),
  },
  'simple-demo': {
    id: 'simple-demo',
    name: 'Simple Demo Planner',
    toHarnessCfg: (applied?: any) => ({ mode: (applied?.mode || 'suggest') }),
  },
};

export function resolvePlanner(id: string) {
  if (id === 'llm-drafter') return LLMDrafterPlanner;
  if (id === 'scenario-v0.3') return ScenarioPlannerV03;
  if (id === 'simple-demo') return SimpleDemoPlanner;
  return SimpleDemoPlanner;
}
