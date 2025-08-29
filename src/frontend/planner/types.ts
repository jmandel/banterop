import type React from 'react';

export type HydrateCtx = { fetchJson: (url: string) => Promise<any>; cache: Map<string, any> };

export interface PlannerSetupApi<Cfg = any, Seed = any> {
  // Store-driven setup component: reads + writes to useAppStore. No props.
  SetupComponent: () => React.ReactElement;

  // Compact seed for URL hash
  dehydrate(config: Cfg): Seed;

  // Expand seed into full config (and signal ready-ness)
  hydrate(seed: Seed, ctx: HydrateCtx): Promise<{ config: Cfg; ready: boolean }>; 
}
