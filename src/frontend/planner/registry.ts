import { LLMDrafterPlanner } from './planners/llm-drafter';
// Attach config companions (side-effect imports)
import './planners/llm-drafter-config';
import { SimpleDemoPlanner } from './planners/simple-demo';
import { ScenarioPlannerV03 } from './planners/scenario-planner';
import './planners/scenario-config';

// Thin registry: resolve by id; planners themselves expose names and cfg mappers
export function resolvePlanner(id: string) {
  if (id === 'llm-drafter') return LLMDrafterPlanner;
  if (id === 'scenario-v0.3') return ScenarioPlannerV03;
  if (id === 'simple-demo') return SimpleDemoPlanner;
  return SimpleDemoPlanner;
}
