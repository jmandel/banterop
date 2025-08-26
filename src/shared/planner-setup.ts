export type PlannerSetupState = {
  plannerId: 'off' | 'llm-drafter' | 'simple-demo';
  stagedByPlanner: Record<string, any>;
  appliedByPlanner: Record<string, any>;
  readyByPlanner: Record<string, boolean>;
};

export function getAppliedCfg(state: PlannerSetupState) {
  const id = state.plannerId;
  if (id === 'off') return undefined;
  return state.appliedByPlanner[id];
}

export function isReady(state: PlannerSetupState) {
  const id = state.plannerId;
  return id !== 'off' && !!state.readyByPlanner[id];
}

