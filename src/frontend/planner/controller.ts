import { DEFAULT_BANTEROP_ENDPOINT, DEFAULT_BANTEROP_MODEL, makeBanteropProvider } from '../../shared/llm-provider';
import { makeOpenAICompatibleProvider } from '../../shared/llm-provider-openai';
import { useAppStore } from '../state/store';
import { PlannerHarness } from './harness';
import { resolvePlanner } from './registry';

let started = false;
let currentHarness: PlannerHarness<any> | null = null;
let lastBuildKey = '';      // fingerprint to avoid redundant rebuilds
let lastSeenPlanNonce = 0;  // to run exactly once per request
let stashedPlanNonce = 0;
// Default provider; may be overridden per-session in rebuild
const defaultLlmProvider = makeBanteropProvider(DEFAULT_BANTEROP_ENDPOINT);

const NopPlanner = { id:'nop', name:'No-op', async plan(){ return []; } } as const;

// Dismiss the latest unsent compose_intent (regardless of author) to unblock replanning
function dismissLatestUnsentDraft(): void {
  const s = useAppStore.getState();
  const facts = s.facts;
  if (!facts || !facts.length) return;
  const dismissed = new Set<string>(facts.filter(f => f.type === 'compose_dismissed').map((f:any) => String(f.composeId||'')));
  for (let i = facts.length - 1; i >= 0; --i) {
    const f = facts[i];
    if (f.type === 'message_sent') break;
    if (f.type === 'compose_intent') {
      const cid = String((f as any).composeId || '');
      if (!cid || dismissed.has(cid)) continue;
      // Found latest unsent draft → dismiss it with CAS at current head
      try { s.append([{ type:'compose_dismissed', composeId: cid } as any], { casBaseSeq: s.head() }); } catch {}
      break;
    }
  }
}

export function startPlannerController() {
  if (started) return; // idempotent start
  started = true;

  function rebuildHarness() {
    const s = useAppStore.getState();
    const plannerId = s.plannerId || 'off';
    const ready = !!s.readyByPlanner[plannerId];
    const config = s.configByPlanner?.[plannerId];
    const planner = ready && plannerId !== 'off' ? resolvePlanner(plannerId) : (NopPlanner as any);
    const cfg = ready && plannerId !== 'off' ? (config ?? {}) : {};
    const getFacts = () => useAppStore.getState().facts;
    const getHead  = () => useAppStore.getState().head();
    const append   = (batch:any, opts?:{casBaseSeq?:number}) => useAppStore.getState().append(batch, opts);
    const hud      = (phase:any, label?:string, p?:number) => useAppStore.getState().setHud(phase, label, p);
    // Choose LLM provider + model from session settings (if present)
    let modelFromSession: string | undefined;
    let provider = defaultLlmProvider;
    try {
      const raw = (typeof window !== 'undefined') ? window.sessionStorage.getItem('clientSettings') : null;
      if (raw) {
        const j = JSON.parse(raw);
        const prov = j?.llm?.provider;
        const baseUrl = (j?.llm?.baseUrl || '').trim();
        const m = (j?.llm?.model || '').trim();
        modelFromSession = m || undefined;
        // API key comes from localStorage only (never from hash/session)
        let apiKey = '';
        try { apiKey = (typeof window !== 'undefined') ? (localStorage.getItem('client.llm.apiKey') || '') : ''; } catch {}
        if (prov === 'client-openai' && apiKey && baseUrl) {
          provider = makeOpenAICompatibleProvider({ baseUrl, apiKey });
        }
      }
    } catch {}
    // Resolve model with session default as fallback
    let model = (config?.model && String(config.model).trim()) || modelFromSession || DEFAULT_BANTEROP_MODEL;
    // If using server-hosted provider, verify model is available; fallback if not
    try {
      const models = useAppStore.getState().catalogs.llmModels || [];
      const usingServer = provider === defaultLlmProvider; // crude check: browserside/server
      if (usingServer && models.length && !models.includes(model)) {
        const fallback = models[0] || DEFAULT_BANTEROP_MODEL;
        if (fallback !== model) {
          try { console.warn('[planner/controller] Model not available on server:', model, '→ using', fallback); } catch {}
          model = fallback;
        }
      }
    } catch {}
    currentHarness = new PlannerHarness(
      getFacts,
      getHead,
      append,
      hud,
      planner as any,
      cfg as any,
      { otherAgentId:'counterpart', model, existingTask: !!s.taskId } as any,
      provider
    );
    // Don't auto-plan on rebuild - let explicit requests handle it
    try { console.debug('[planner/controller] harness rebuilt', { pid: plannerId, ready, task: !!s.taskId }); } catch {}
  }

  rebuildHarness();
  // Initial UI sync for setup panel based on current readiness
  try {
    const s0 = useAppStore.getState();
    const pid0 = s0.plannerId;
    const ready0 = !!s0.readyByPlanner[pid0];
    s0.onPlannerSelected(pid0, ready0);
  } catch {}
  // Rebuild harness when it matters (including config changes)
  useAppStore.subscribe((s, prev) => {
    const pid = s.plannerId;
    const ready = !!s.readyByPlanner[pid];

    // Check if basic state changed (planner, task, ready)
    const basicKey = [pid, s.taskId || '', ready ? '1' : '0'].join('|');
    const basicChanged = basicKey !== lastBuildKey;

    // Check if config changed (for applied configs, not transient typing)
    const configChanged = ready && JSON.stringify(s.configByPlanner[pid]) !== JSON.stringify(prev.configByPlanner[pid]);

    if (basicChanged || configChanged) {
      lastBuildKey = basicKey;
      rebuildHarness();
      // Flush any stashed plan request once barrier opens
      const canPlan = (() => s.plannerId !== 'off' && !!s.readyByPlanner[s.plannerId] && !!s.adapter)();
      if (canPlan && stashedPlanNonce > lastSeenPlanNonce) {
        lastSeenPlanNonce = stashedPlanNonce;
        try { currentHarness?.schedulePlan(); } catch {}
      }
    }

    // Setup UI state machine transitions
    const pidChanged = s.plannerId !== prev.plannerId;
    if (pidChanged) {
      try {
        s.onPlannerSelected(s.plannerId, ready);
      } catch {}
    }

    // When planner becomes ready against an existing task, request a single replan
    const prevReady = !!prev.readyByPlanner[prev.plannerId || pid];
    if (!prevReady && ready && s.taskId) {
      try { useAppStore.getState().requestReplan('boot-ready'); } catch {}
    }
    // Note: avoid set-state here to prevent nested update loops
  });
  // Trigger planning when journal head advances
  let prevSeq = useAppStore.getState().seq || 0;
  useAppStore.subscribe((s) => {
    const seq = s.seq || 0;
    if (seq !== prevSeq) {
      prevSeq = seq;
      try { console.debug('[planner/controller] journal advanced', { seq }); } catch {}
      try { currentHarness?.schedulePlan(); } catch {}
    }
  });

  // Run exactly once when someone requests a replan; stash if barrier closed
  useAppStore.subscribe((s) => {
    const nonce = (s as any).planNonce || 0;
    if (nonce !== lastSeenPlanNonce) {
      const canPlan = (s.plannerId !== 'off' && !!s.readyByPlanner[s.plannerId] && !!s.adapter);
      if (canPlan) {
        try { console.debug('[planner/controller] planNonce observed (barrier open)', { nonce }); } catch {}
        lastSeenPlanNonce = nonce;
        currentHarness?.schedulePlan();
      } else {
        stashedPlanNonce = nonce;
        try { console.debug('[planner/controller] planNonce stashed (barrier closed)', { nonce }); } catch {}
      }
    }
  });

  // When barrier opens (adapter + planner ready), flush stashed plan
  useAppStore.subscribe((s, prev) => {
    const wasClosed = !(prev.plannerId !== 'off' && !!prev.readyByPlanner[prev.plannerId] && !!prev.adapter);
    const nowOpen = (s.plannerId !== 'off' && !!s.readyByPlanner[s.plannerId] && !!s.adapter);
    if (wasClosed && nowOpen && (s.pendingKickoff || stashedPlanNonce > lastSeenPlanNonce)) {
      try { console.debug('[planner/controller] barrier opened — flushing stashed or pending kickoff', { stashedPlanNonce, lastSeenPlanNonce, pendingKickoff: s.pendingKickoff }); } catch {}
      lastSeenPlanNonce = Math.max(lastSeenPlanNonce, stashedPlanNonce);
      try { currentHarness?.schedulePlan(); } catch {}
    }
  });
}
