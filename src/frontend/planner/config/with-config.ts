import type { Planner } from '../../../shared/journal-types';
import type { PlannerConfigStore } from './store';

export type PlannerWithConfig<Cfg = unknown, Applied = unknown> =
  Planner<Cfg> & {
    createConfigStore: (opts: { llm: any; initial?: Applied }) => PlannerConfigStore;
    summarizeApplied?: (applied?: Applied) => string;
    toHarnessCfg: (applied: Applied) => Cfg;
  };

