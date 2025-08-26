import type { ConfigSnapshot } from './types';

export type PlannerConfigStore = {
  // state
  snap: ConfigSnapshot;

  // actions
  setField: (key: string, value: unknown) => void;
  exportApplied: () => { applied: any; ready: boolean };
  destroy: () => void;
  // subscribe for React reactivity
  subscribe: (listener: () => void) => () => void;
};
