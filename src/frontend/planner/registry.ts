import { LLMDrafterPlanner } from './planners/llm-drafter';

import { SimpleDemoPlanner } from './planners/simple-demo';

import { ScenarioPlannerV03 } from './planners/scenario-planner';

export function resolvePlanner(id: string) {
  if (id === 'llm-drafter') return LLMDrafterPlanner;
  if (id === 'scenario-v0.3') return ScenarioPlannerV03;
  if (id === 'simple-demo') return SimpleDemoPlanner;
  return SimpleDemoPlanner;
}
