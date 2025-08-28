import type { Planner } from '../../../shared/journal-types';
import type { PlannerConfigStore } from './store';
import type { SavedField } from './types';

export type PlannerWithConfig<Cfg = unknown, Seed = unknown> =
  Planner<Cfg> & {
    // Build the in-memory FullConfig from a compact seed (may fetch).
    hydrate?: (seed: Seed, ctx?: { fetchJson?: (url: string) => Promise<any>, cache?: Map<string, any> }) =>
      Promise<{ config: Cfg; ready: boolean }>;

    // Create a compact, URL-safe seed from a FullConfig (pure; no network).
    dehydrate?: (config: Cfg) => Seed;

    // Config UI store for this planner; prefer savedFields, legacy initial supported
    createConfigStore?: (opts: { llm: any; savedFields?: SavedField[]; initial?: Cfg }) => PlannerConfigStore;

    // Optional human summary (legacy name kept)
    summarizeApplied?: (config?: Cfg) => string;
  };
