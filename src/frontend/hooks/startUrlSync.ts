import { useAppStore } from '../state/store';
import { decodeSetup, encodeSetup } from '../../shared/setup-hash';
import { resolvePlanner } from '../planner/registry';

const hydrationCache = new Map<string, any>();

// Shared fetchJson utility to avoid duplication
const fetchJson = async (url: string) => {
  const key = `json:${url}`;
  if (hydrationCache.has(key)) return hydrationCache.get(key);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  const MAX = 1_500_000;
  const text = await response.text();
  if (text.length > MAX) throw new Error('Response exceeds 1.5 MB limit');
  try { return JSON.parse(text); } catch { throw new Error('Invalid JSON'); }
};

export function startUrlSync() {
  let localRev = 0;
  let suppress = false;

  // Boot: read #setup
  (async () => {
    try { console.debug('[urlSync] boot: reading hash…'); } catch {}
    const setup = decodeSetup(window.location.hash) as any;
    const plannerSetup = setup && (setup.planner || setup);
    if (!plannerSetup) { try { console.debug('[urlSync] boot: no planner payload in hash'); } catch {}; return; }

    const id = plannerSetup.id as string | undefined;
    const mode = plannerSetup.mode as ('approve'|'auto') | undefined;
    const seed = (plannerSetup.seed ?? plannerSetup.applied ?? plannerSetup.config) as any;
    const rev = Number(plannerSetup.rev ?? setup?.rev ?? 0);

    try { console.debug('[urlSync] boot: id=%o mode=%o rev=%o seed=%o', id, mode, rev, (plannerSetup.seed ?? plannerSetup.applied ?? plannerSetup.config)); } catch {}
    if (id) { try { console.debug('[urlSync] boot: setPlanner(%o)', id); } catch {}; useAppStore.getState().setPlanner(id as any); }
    if (mode) { try { console.debug('[urlSync] boot: setPlannerMode(%o)', mode); } catch {}; useAppStore.getState().setPlannerMode(mode); }

    if (id && seed) {
        const planner: any = resolvePlanner(id);
        if (planner?.hydrate) {
          try { console.debug('[urlSync] boot: first hydrate(%o)…', id); } catch {}
          const res = await planner.hydrate(seed, {
            fetchJson,
            cache: hydrationCache
          });
          // Accept both shapes:
          //  - VM hydrators: { full, fields? }
          //  - Planner hydrators: { config, ready, fields? }
          const config = (res as any)?.config ?? (res as any)?.full;
          const ready  = (res as any)?.ready ?? !!config;
          const fields = (res as any)?.fields;
          if (Array.isArray(fields)) { console.debug('[urlSync] boot: seeding savedFields (count=%o)', fields.length); useAppStore.getState().setPlannerSavedFields(fields); }
          console.debug('[urlSync] boot: hydrate → ready=%o, summary=%o', !!ready, summarizeConfigForLog(id, config));
          if (config) {
            useAppStore.getState().setPlannerConfig(config, !!ready);

            // CRITICAL: Also set readyByPlanner for the UI to stay collapsed
            useAppStore.setState(s => ({
              readyByPlanner: { ...s.readyByPlanner, [id]: !!ready }
            }));
          }

          // NEW: fast-forward the planner's config store fields from the seed
            const store = useAppStore.getState().configStores[id];
            console.debug('[urlSync] boot: found config store?', !!store, "initializeFromSeed?", store && typeof (store as any).initializeFromSeed === 'function');
            if (store && typeof (store as any).initializeFromSeed === 'function') {
              await (store as any).initializeFromSeed(seed);
            }
        }
    }
    if (Number.isFinite(rev)) localRev = Math.max(localRev, Number(rev));
  })();

  // Cross‑tab & manual hash edits
  window.addEventListener('hashchange', async () => {
    if (suppress) return;
    try { console.debug('[urlSync] hashchange: reading hash…'); } catch {}
    const setup = decodeSetup(window.location.hash) as any;
    const plannerSetup = setup && (setup.planner || setup);
    const incomingRev = Number(plannerSetup?.rev ?? setup?.rev ?? 0);
    if (incomingRev && incomingRev <= localRev) return; // stale

    const id = (plannerSetup?.id || useAppStore.getState().plannerId) as string | undefined;
    if (id) { try { console.debug('[urlSync] hashchange: setPlanner(%o)', id); } catch {}; useAppStore.getState().setPlanner(id as any); }
    const mode = plannerSetup?.mode as ('approve'|'auto') | undefined;
    if (mode) { try { console.debug('[urlSync] hashchange: setPlannerMode(%o)', mode); } catch {}; useAppStore.getState().setPlannerMode(mode); }

    const seed = (plannerSetup?.seed ?? plannerSetup?.applied ?? plannerSetup?.config) as any;
    if (id && seed) {
      try {
        const planner = resolvePlanner(id);
        if (planner?.hydrate) {
          try { console.debug('[urlSync] hashchange: hydrate(%o)…', id); } catch {}
          const res = await planner.hydrate(seed, {
            fetchJson,
            cache: hydrationCache
          });
          // Accept both shapes:
          //  - VM hydrators: { full, fields? }
          //  - Planner hydrators: { config, ready, fields? }
          const config = (res as any)?.config ?? (res as any)?.full;
          const ready  = (res as any)?.ready ?? !!config;
          try {
            const fields = (res as any)?.fields;
            if (Array.isArray(fields)) { console.debug('[urlSync] hashchange: seeding savedFields (count=%o)', fields.length); useAppStore.getState().setPlannerSavedFields(fields); }
          } catch {}
          try { console.debug('[urlSync] hashchange: hydrate → ready=%o, summary=%o', !!ready, summarizeConfigForLog(id, config)); } catch {}
          if (config) {
            useAppStore.getState().setPlannerConfig(config, !!ready);

            // CRITICAL: Also set readyByPlanner for the UI to stay collapsed
            useAppStore.setState(s => ({
              readyByPlanner: { ...s.readyByPlanner, [id]: !!ready }
            }));
          }

          // NEW: fast-forward the planner's config store fields from the seed
          try {
            const store = useAppStore.getState().configStores[id];
            if (store && typeof (store as any).initializeFromSeed === 'function') {
              await (store as any).initializeFromSeed(seed);
            }
          } catch {}
        }
      } catch {}
    }
    if (Number.isFinite(incomingRev)) localRev = Math.max(localRev, Number(incomingRev));
  });

  // Store -> URL
  useAppStore.subscribe((s, prev) => {
    const pidChanged   = s.plannerId !== prev.plannerId;
    const modeChanged  = s.plannerMode !== prev.plannerMode;
    const cfgChanged   = (s as any).configByPlanner !== (prev as any).configByPlanner;
    if (!(pidChanged || modeChanged || cfgChanged)) return;

    const pid = s.plannerId;
    const planner: any = resolvePlanner(pid);
    const cfg = (s as any).configByPlanner?.[pid];

    const seed = (cfg && planner?.dehydrate) ? planner.dehydrate(cfg) : undefined;
    try { console.debug('[urlSync] store→url: pid=%o mode=%o seed=%o summary=%o', pid, s.plannerMode, seed, summarizeConfigForLog(pid, cfg)); } catch {}

    const payload = { v: 2, planner: { id: pid, mode: s.plannerMode, seed, rev: ++localRev } };

    suppress = true;
    try {
      const hash = encodeSetup(payload as any);
      if (hash) window.location.hash = hash;
    } catch {}
    finally { setTimeout(() => { suppress = false; }, 0); }
  });
}

function summarizeConfigForLog(pid: string | undefined, cfg: any): any {
  if (!cfg) return null;
  try {
    if (pid === 'scenario-v0.3' || (cfg && (cfg as any).scenario)) {
      const scen = (cfg as any).scenario || {};
      // Use clean scenarioUrl field instead of monkeypatched __sourceUrl
      const url = (cfg as any).scenarioUrl || '';
      const agents = Array.isArray((scen as any).agents) ? (scen as any).agents.length : 0;
      const model = String((cfg as any).model || '');
      const myAgentId = String((cfg as any).myAgentId || '');
      const tools = Array.isArray((cfg as any).enabledTools) ? (cfg as any).enabledTools.length : 0;
      const core = Array.isArray((cfg as any).enabledCoreTools) ? (cfg as any).enabledCoreTools.length : 0;
      const steps = Number((cfg as any).maxInlineSteps || 0);
      return { scenarioUrl: url, agents, myAgentId, model, enabledTools: tools, enabledCoreTools: core, maxInlineSteps: steps };
    }
  } catch {}
  return cfg;
}
