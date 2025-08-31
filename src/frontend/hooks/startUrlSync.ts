import { useAppStore } from '../state/store';
import { resolvePlanner } from '../planner/registry';

// New readable-hash format support
// Example:
// #{"transport":"a2a","agentCardUrl":"https://…/agent-card.json","mcpUrl":"",
//   "llm":{"provider":"server","model":"@preset/banterop"},
//   "planner":{"id":"scenario-v0.3","mode":"auto"},
//   "planners":{"scenario-v0.3":{"seed":{...}},"llm-drafter":{"seed":{...}}},
//   "rev": 3}
function tryParseReadableHash(hash: string): any | null {
  if (!hash) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const candidates = [raw];
  try { candidates.push(decodeURIComponent(raw)); } catch {}
  for (const c of candidates) {
    const s = c.trim();
    if (!s.startsWith('{') || !s.endsWith('}')) continue;
    try { const j = JSON.parse(s); if (j && typeof j === 'object') return j; } catch {}
  }
  return null;
}

function writeClientSettingsFromPayload(_p: any) { /* no-op: hash is the source */ }

export function buildReadableHashFromStore(): string {
  const s = useAppStore.getState();
  // Read client settings from session (most recent edits), fallback to current hash
  let client: any = {};
  try { const raw = window.sessionStorage.getItem('clientSettings'); if (raw) client = JSON.parse(raw); } catch {}
  if (!client || typeof client !== 'object') {
    try { const cur = tryParseReadableHash(window.location.hash); client = cur || {}; } catch {}
  }
  // Preserve optional roomTitle across rewrites when present
  let roomTitle: string | undefined;
  let seedFromHash: any | undefined;
  try {
    const cur = tryParseReadableHash(window.location.hash);
    if (cur && typeof (cur as any).roomTitle === 'string') roomTitle = (cur as any).roomTitle;
    const pid0 = s.plannerId;
    if (cur && typeof cur === 'object' && pid0 && (cur as any).planners && (cur as any).planners[pid0] && (cur as any).planners[pid0].seed) {
      seedFromHash = (cur as any).planners[pid0].seed;
    }
  } catch {}
  const pid = s.plannerId;
  const planner: any = resolvePlanner(pid);
  const row = (s as any).plannerSetup?.byPlanner?.[pid];
  const cfg = row?.draft || (s as any).configByPlanner?.[pid];
  // Prefer dehydrate(cfg) when complete; if incomplete, fill missing fields from the hash seed
  function isEmpty(val: any): boolean { return val == null || (typeof val === 'string' && val.trim() === ''); }
  function fillMissing(base: any, fallback: any): any {
    if (!fallback || typeof fallback !== 'object') return base;
    const out: any = Array.isArray(base) ? [...base] : { ...(base || {}) };
    for (const k of Object.keys(fallback)) {
      const v = (out as any)[k];
      if (isEmpty(v)) (out as any)[k] = (fallback as any)[k];
    }
    return out;
  }
  let seed: any = undefined;
  try {
    const dehydrated = (cfg && planner?.dehydrate) ? planner.dehydrate(cfg) : undefined;
    if (dehydrated && seedFromHash) seed = fillMissing(dehydrated, seedFromHash);
    else seed = dehydrated || seedFromHash || undefined;
  } catch { seed = seedFromHash || undefined; }
  const payload: any = {
    // transport omitted; both URLs are included when present
    ...(client.a2aCardUrl ? { agentCardUrl: client.a2aCardUrl } : {}),
    ...(client.mcpUrl ? { mcpUrl: client.mcpUrl } : {}),
    llm: {
      provider: (client.llm?.provider || 'server'),
      model: client.llm?.model,
      ...(client.llm?.provider === 'client-openai' && client.llm?.baseUrl ? { baseUrl: client.llm.baseUrl } : {}),
      // apiKey intentionally excluded from hash
    },
    planner: { id: pid, mode: s.plannerMode },
    planners: seed ? { [pid]: { seed } } : {},
    ...(roomTitle ? { roomTitle } : {}),
    rev: undefined // filled by caller
  };
  return JSON.stringify(payload);
}

export function startUrlSync() {
  let localRev = 0;
  let suppress = false;
  let lastCore: string | null = null;

  // Boot: read hash (readable JSON only)
  (async () => {
    try { console.debug('[urlSync] boot: reading hash…'); } catch {}
    const readable = tryParseReadableHash(window.location.hash);
    if (readable) {
      // Apply client settings
      writeClientSettingsFromPayload(readable);
      const pid = String(readable?.planner?.id || 'off');
      let mode = readable?.planner?.mode as ('approve'|'auto'|undefined);
      // Tolerate top-level requireReview boolean override when mode is absent
      if (!mode && typeof (readable as any)?.requireReview === 'boolean') {
        mode = (readable as any).requireReview ? 'approve' : 'auto';
      }
      if (pid) useAppStore.getState().setPlanner(pid as any);
      if (mode) useAppStore.getState().setPlannerMode(mode);
      const chosenSeed = readable?.planners?.[pid]?.seed || readable?.planner?.seed || readable?.seed;
      if (pid && chosenSeed) { try { await useAppStore.getState().hydrateFromSeed(pid, chosenSeed); } catch (e) { console.debug('[urlSync] boot: hydrateFromSeed error', e); } }
      const rev = Number(readable?.rev || 0);
      if (Number.isFinite(rev)) localRev = Math.max(localRev, Number(rev));
      return;
    }
  })();

  // Cross‑tab & manual hash edits
  window.addEventListener('hashchange', async () => {
    if (suppress) return;
    try { console.debug('[urlSync] hashchange: reading hash…'); } catch {}
    const readable = tryParseReadableHash(window.location.hash);
    if (readable) {
      const incomingRev = Number(readable?.rev || 0);
      if (incomingRev && incomingRev <= localRev) return; // stale
      writeClientSettingsFromPayload(readable);
      const id = String(readable?.planner?.id || useAppStore.getState().plannerId || 'off');
      let mode = readable?.planner?.mode as ('approve'|'auto'|undefined);
      if (!mode && typeof (readable as any)?.requireReview === 'boolean') {
        mode = (readable as any).requireReview ? 'approve' : 'auto';
      }
      const cur = useAppStore.getState();
      if (id && cur.plannerId !== id) useAppStore.getState().setPlanner(id as any);
      if (mode && cur.plannerMode !== mode) useAppStore.getState().setPlannerMode(mode);
      const seed = readable?.planners?.[id]?.seed || readable?.planner?.seed || readable?.seed;
      if (id && seed) { try { await useAppStore.getState().hydrateFromSeed(id, seed); } catch {} }
      if (Number.isFinite(incomingRev)) localRev = Math.max(localRev, Number(incomingRev));
      return;
    }
  });

  // Store -> URL
  useAppStore.subscribe((s, prev) => {
    const pidChanged   = s.plannerId !== prev.plannerId;
    const modeChanged  = s.plannerMode !== prev.plannerMode;
    const cfgChanged   = (s as any).configByPlanner !== (prev as any).configByPlanner;
    const rowNow = (s as any).plannerSetup?.byPlanner?.[s.plannerId];
    const rowPrev = (prev as any).plannerSetup?.byPlanner?.[prev.plannerId];
    const seedChanged = JSON.stringify(rowNow?.seed) !== JSON.stringify(rowPrev?.seed);
    if (!(pidChanged || modeChanged || cfgChanged || seedChanged)) return;

    const core = buildReadableHashFromStore();
    if (core === lastCore) return;
    lastCore = core;
    const pid = s.plannerId;
    const cfg = rowNow?.draft || (s as any).configByPlanner?.[pid];
    try { console.debug('[urlSync] store→url: pid=%o mode=%o cfg=%o summary=%o', pid, s.plannerMode, !!cfg, summarizeConfigForLog(pid, cfg)); } catch {}

    // Write human-readable JSON into hash (no rev; keep existing values stable)
    suppress = true;
    try {
      window.location.hash = core;
    } catch {}
    finally { setTimeout(() => { suppress = false; }, 0); }
  });
}

// Imperative helper to update the readable JSON hash from current store + session client settings
export function updateReadableHashFromStore() {
  try {
    const core = buildReadableHashFromStore();
    const cur = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (core !== cur) window.location.hash = core;
  } catch {}
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
