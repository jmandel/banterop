import type { ConfigSnapshot, SavedField } from './types';

export type PlannerConfigStore = {
  // state
  snap: ConfigSnapshot;

  // actions
  setField: (key: string, value: unknown) => void;
  exportFullConfig: () => { config: any; ready: boolean; savedFields: SavedField[] };
  destroy: () => void;
  // subscribe for React reactivity
  subscribe: (listener: () => void) => () => void;
};
