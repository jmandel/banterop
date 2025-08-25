// copied from src-with-planner/frontend/planner/planners/scenario-planner.ts (trimmed placeholder)
import type { Planner, PlanContext, PlanInput, ProposedFact } from '../../../shared/journal-types';

export const ScenarioPlanner: Planner = {
  id: 'scenario-planner',
  name: 'Scenario Planner',
  plan(input: PlanInput, ctx: PlanContext): ProposedFact[] {
    // Placeholder: not wired in this patch
    return [];
  }
};

