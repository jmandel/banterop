import { DEFAULT_CHITCHAT_ENDPOINT, DEFAULT_CHITCHAT_MODEL, makeChitchatProvider } from '../../shared/llm-provider';
import { makeOpenAICompatibleProvider } from '../../shared/llm-provider-openai';
import { useAppStore } from '../state/store';
import { PlannerHarness } from './harness';
import { resolvePlanner } from './registry';

let started = false;
let currentHarness: PlannerHarness<any> | null = null;
let lastBuildKey = '';      // fingerprint to avoid redundant rebuilds
let lastSeenPlanNonce = 0;  // to run exactly once per request
// Default provider; may be overridden per-session in rebuild
const defaultLlmProvider = makeChitchatProvider(DEFAULT_CHITCHAT_ENDPOINT);

const NopPlanner = { id:'nop', name:'No-op', async plan(){ return []; } } as const;

// Dismiss the latest unsent compose_intent (regardless of author) to unblock replanning
function dismissLatestUnsentDraft(): void {
  const s = useAppStore.getState();
  const facts = s.facts;
  if (!facts || !facts.length) return;
  const dismissed = new Set<string>(facts.filter(f => f.type === 'compose_dismissed').map((f:any) => String(f.composeId||'')));
  for (let i = facts.length - 1; i >= 0; --i) {
    const f = facts[i];
    if (f.type === 'remote_sent') break;
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
        const apiKey = (j?.llm?.apiKey || '').trim();
        const baseUrl = (j?.llm?.baseUrl || '').trim();
        const m = (j?.llm?.model || '').trim();
        modelFromSession = m || undefined;
        if (prov === 'client-openai' && apiKey && baseUrl) {
          provider = makeOpenAICompatibleProvider({ baseUrl, apiKey });
        }
      }
    } catch {}
    // Resolve model with session default as fallback
    let model = (config?.model && String(config.model).trim()) || modelFromSession || DEFAULT_CHITCHAT_MODEL;
    // If using server-hosted provider, verify model is available; fallback if not
    try {
      const models = useAppStore.getState().catalogs.llmModels || [];
      const usingServer = provider === defaultLlmProvider; // crude check: browserside/server
      if (usingServer && models.length && !models.includes(model)) {
        const fallback = models[0] || DEFAULT_CHITCHAT_MODEL;
        if (fallback !== model) {
          try { console.warn('[planner/controller] Model not available on server:', model, '→ using', fallback); } catch {}
          model = fallback;
        }
      }
    } catch {}
    currentHarness = new PlannerHarness(getFacts, getHead, append, hud, planner as any, cfg as any, { otherAgentId:'counterpart', model }, provider);
    // Don't auto-plan on rebuild - let explicit requests handle it
  }

  rebuildHarness();
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
  });
  // Trigger planning when journal head advances
  let prevSeq = useAppStore.getState().seq || 0;
  useAppStore.subscribe((s) => {
    const seq = s.seq || 0;
    if (seq !== prevSeq) {
      prevSeq = seq;
      try { currentHarness?.schedulePlan(); } catch {}
    }
  });

  // Run exactly once when someone requests a replan (apply / boot-ready)
  useAppStore.subscribe((s) => {
    const nonce = (s as any).planNonce || 0;
    if (nonce !== lastSeenPlanNonce) {
      lastSeenPlanNonce = nonce;
      currentHarness?.schedulePlan();
    }
  });
}
