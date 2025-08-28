import { LLMDrafterPlanner } from './planners/llm-drafter';
import './planners/llm-drafter-setup-vm'; // attaches createSetupVM + de/hydrate + createConfigStore to LLMDrafterPlanner

import { SimpleDemoPlanner } from './planners/simple-demo';

import { ScenarioPlannerV03 } from './planners/scenario-planner';
import './planners/scenario-setup-vm'; // NEW: attaches createSetupVM + de/hydrate to ScenarioPlannerV03

export function resolvePlanner(id: string) {
  if (id === 'llm-drafter') return LLMDrafterPlanner;
  if (id === 'scenario-v0.3') return ScenarioPlannerV03;
  if (id === 'simple-demo') return SimpleDemoPlanner;
  return SimpleDemoPlanner;
}
