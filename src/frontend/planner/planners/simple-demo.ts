// copied from src-with-planner/frontend/planner/planners/simple-demo.ts
import type { Planner, ProposedFact, PlanInput, PlanContext } from '../../../shared/journal-types';

export const SimpleDemoPlanner: Planner = {
  id: 'simple-demo',
  name: 'Simple Demo',
  plan(input: PlanInput, ctx: PlanContext): ProposedFact[] {
    // trivial no-op demo
    return [];
  }
};

