import { PlannerHarness } from './harness';
import { SimpleDemoPlanner } from './planners/simple-demo';
import { resolvePlanner } from './registry';
import { useAppStore } from '../state/store';
import { makeChitchatProvider, DEFAULT_CHITCHAT_ENDPOINT, DEFAULT_CHITCHAT_MODEL } from '../../shared/llm-provider';

let started = false;
let currentHarness: PlannerHarness<any> | null = null;
const sharedLlmProvider = makeChitchatProvider(DEFAULT_CHITCHAT_ENDPOINT);

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
    const model = (config?.model && String(config.model).trim()) || DEFAULT_CHITCHAT_MODEL;
    currentHarness = new PlannerHarness(getFacts, getHead, append, hud, planner as any, cfg as any, { otherAgentId:'counterpart', model }, sharedLlmProvider);
    // Kick once now
    try { currentHarness.schedulePlan(); } catch {}
  }

  rebuildHarness();
  // Rebuild harness if planner or readiness or config or task changes
  useAppStore.subscribe((s, prev) => {
    const pidChanged = s.plannerId !== prev.plannerId;
    const taskChanged = s.taskId !== prev.taskId;
    const readyChanged = s.readyByPlanner !== prev.readyByPlanner;
    const configChanged = s.configByPlanner !== (prev as any).configByPlanner;
    const newPlannerReady = !!s.readyByPlanner[s.plannerId || 'off'];
    let rebuilt = false;
    // If planner id or config changed (and not due to task change), and the new planner is ready,
    // rebuild first so the next seq change (from dismissal) schedules planning on the NEW harness.
    if ((pidChanged || configChanged) && newPlannerReady && !taskChanged) {
      rebuildHarness();
      rebuilt = true;
      try { dismissLatestUnsentDraft(); } catch {}
    }
    if (!rebuilt && (pidChanged || taskChanged || readyChanged || configChanged)) rebuildHarness();
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
}
