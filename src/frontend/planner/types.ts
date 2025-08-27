export type PlannerApplied =
  | { id: 'llm-drafter'; model?: string }
  | { id: 'scenario-v0.3'; scenarioUrl: string; model?: string; myAgentId?: string; enabledTools?: string[] }
  | { id: 'simple-demo' };

