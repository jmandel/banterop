import { PlannerHarness } from './harness';
import { SimpleDemoPlanner } from './planners/simple-demo';
import { resolvePlanner, PlannerRegistry } from './registry';
import { useAppStore } from '../state/store';
import { makeChitchatProvider, DEFAULT_CHITCHAT_ENDPOINT, DEFAULT_CHITCHAT_MODEL } from '../../shared/llm-provider';

let started = false;
let currentHarness: PlannerHarness<any> | null = null;
const sharedLlmProvider = makeChitchatProvider(DEFAULT_CHITCHAT_ENDPOINT);

const NopPlanner = { id:'nop', name:'No-op', async plan(){ return []; } } as const;

export function startPlannerController() {
  if (started) return; // idempotent start
  started = true;

  function rebuildHarness() {
    const s = useAppStore.getState();
    const plannerId = s.plannerId || 'off';
    const ready = !!s.readyByPlanner[plannerId];
    const applied = s.appliedByPlanner[plannerId];
    const planner = ready && plannerId !== 'off' ? resolvePlanner(plannerId) : (NopPlanner as any);
    const cfg = ready && plannerId !== 'off' ? (PlannerRegistry[plannerId]?.toHarnessCfg(applied) || {}) : {};
    const getFacts = () => useAppStore.getState().facts;
    const getHead  = () => useAppStore.getState().head();
    const append   = (batch:any, opts?:{casBaseSeq?:number}) => useAppStore.getState().append(batch, opts);
    const hud      = (phase:any, label?:string, p?:number) => useAppStore.getState().setHud(phase, label, p);
    const model = (applied?.model && String(applied.model).trim()) || DEFAULT_CHITCHAT_MODEL;
    currentHarness = new PlannerHarness(getFacts, getHead, append, hud, planner as any, cfg as any, { myAgentId:'planner', otherAgentId:'counterpart', model }, sharedLlmProvider);
    // Kick once now
    try { currentHarness.schedulePlan(); } catch {}
  }

  rebuildHarness();
  // Rebuild harness if planner or readiness or applied config or task changes
  useAppStore.subscribe((s, prev) => {
    const pidChanged = s.plannerId !== prev.plannerId;
    const taskChanged = s.taskId !== prev.taskId;
    const readyChanged = s.readyByPlanner !== prev.readyByPlanner;
    const appliedChanged = s.appliedByPlanner !== prev.appliedByPlanner;
    if (pidChanged || taskChanged || readyChanged || appliedChanged) rebuildHarness();
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
