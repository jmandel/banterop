import { create } from 'zustand';
import type { A2APart, A2AStatus, A2ANextState } from '../../shared/a2a-types';
import type { Fact, ProposedFact, AttachmentMeta } from '../../shared/journal-types';
import type { TransportAdapter } from '../transports/types';
import { a2aToFacts } from '../../shared/a2a-translator';
import { validateParts } from '../../shared/parts-validator';
import { nowIso, rid } from '../../shared/core';
import { resolvePlanner } from '../planner/registry';
import { fetchJsonCapped } from '../../shared/net';
import { validateScenarioConfig } from '../../shared/scenario-validator';

type Role = 'initiator'|'responder';

// ---- runaway-guard (tiny inline helper) ----
const JOURNAL_HARD_CAP: number = (() => {
  try {
    const w: any = (typeof window !== 'undefined') ? (window as any).__RUNAWAY_LIMIT : undefined;
    const fromWin = (typeof w === 'number' && Number.isFinite(w)) ? w
      : (typeof w === 'string' && w.trim() !== '' && Number.isFinite(Number(w)) ? Number(w) : undefined);
    if (typeof fromWin === 'number' && fromWin > 0) return Math.floor(fromWin);
  } catch {}
  try {
    const s = (typeof window !== 'undefined') ? (window as any)?.localStorage?.getItem?.('RUNAWAY_LIMIT') : null;
    const n = (typeof s === 'string' && s.trim() !== '' && Number.isFinite(Number(s))) ? Number(s) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {}
  return 200; // default (only positive values allowed)
})();
function runawayGuardActive(len: number): boolean { return len >= JOURNAL_HARD_CAP; }

export type Store = {
  // meta
  role: Role;
  taskId?: string;
  currentEpoch?: number;
  adapter?: TransportAdapter;
  fetching: boolean;
  needsRefresh: boolean;
  plannerId: 'off'|'llm-drafter'|'scenario-v0.3'|'simple-demo';
  plannerMode: 'approve'|'auto';
  // planner setup
  configByPlanner: Record<string, any>;
  readyByPlanner: Record<string, boolean>;
  // new config system — store-driven setup state
  plannerSetup: {
    byPlanner: Record<string, {
      draft?: any;
      lastApplied?: any;
      seed?: any;
      valid: boolean;
      dirty: boolean;
      summary?: string;
      pending?: boolean;
      errors?: Record<string,string>;
    }>;
  };
  catalogs: {
    llmModels: string[];
    llmModelsLoaded: boolean;
    scenarioCache: Map<string, any>;
  };
  // journal
  facts: Fact[];
  seq: number;
  // composer
  composing?: { composeId: string; text: string; attachments?: AttachmentMeta[] };
  // helpers
  knownMsg: Set<string>;
  attachmentsIndex: Map<string,{ mimeType:string; bytesBase64:string }>;
  composeApproved: Set<string>;
  inFlightSends: Map<string,{ composeId: string }>;
  sendErrorByCompose: Map<string,string>;
  // actions
  init(role: Role, adapter: TransportAdapter, initialTaskId?: string): void;
  setTaskId(taskId?: string): void;
  startTicks(): void;
  onTick(): void;
  fetchAndIngest(): Promise<void>;
  setPlanner(id:'off'|'llm-drafter'|'scenario-v0.3'|'simple-demo'): void;
  setPlannerMode(mode:'approve'|'auto'): void;
  setPlannerConfig(config: any, ready: boolean): void;
  // setup actions
  setSetupDraft(plannerId: string, partialDraft: any): void;
  setSetupMeta(plannerId: string, meta: Partial<{ valid: boolean; seed?: any; summary?: string; pending?: boolean; errors?: Record<string,string> }>): void;
  applySetup(plannerId: string): void;
  hydrateFromSeed(plannerId: string, seed: any): Promise<void>;
  ensureLlmModelsLoaded(): Promise<void>;
  loadScenario(url: string): Promise<any>;
  // rewind + reconfigure
  rewindJournal(): void; // always rewinds to last public event
  reconfigurePlanner(opts: { config: any; ready: boolean; rewind?: boolean }): void;
  // legacy staging functions removed; planners with config stores persist directly
  appendComposeIntent(text: string, attachments?: AttachmentMeta[]): string;
  sendCompose(composeId: string, nextState: A2ANextState): Promise<void>;
  addUserGuidance(text: string): void;
  addUserAnswer(qid: string, text: string): void;
  dismissCompose(composeId: string): void;
  kickoffConversationWithPlanner(): void;
  // readiness + kickoff
  requestKickoff(reason?: string): void;
  ackKickoffIfPending(): void;
  cancelAndClear(): Promise<void>;
  // backchannel
  attachBackchannel(tasksUrl: string): void;
  detachBackchannel(): void;
  // journal API
  append(batch: ProposedFact[], opts?: { casBaseSeq?: number }): boolean;
  head(): number;
  // selectors (as functions for convenience)
  uiStatus(): string;
  // HUD
  setHud(phase: 'idle'|'reading'|'planning'|'tool'|'drafting'|'waiting', label?: string, p?: number): void;
  hud: { phase: 'idle'|'reading'|'planning'|'tool'|'drafting'|'waiting'; label?: string; p?: number } | null;

  // planning baton
  planNonce: number;
  requestReplan(reason?: string): void;
  // one-shot kickoff if Begin clicked before adapter/controller are ready
  pendingKickoff?: boolean;

  // setup UI state machine
  setupUi: {
    panel: 'open' | 'collapsed';
    lastPlannerId: string;
    autoCollapseOnReady: boolean;
  };
  openSetup(): void;
  collapseSetup(): void;
  onPlannerSelected(newPid: string, readyNow: boolean): void;
  onPlannerReadyFlip(readyNow: boolean): void;
  onApplyClicked(): void;

  // Rooms backend/lease slice (lightweight)
  rooms: {
    byId: Record<string, { leaseId?: string; connState: 'connecting'|'connected'|'observing'|'revoked'|'denied'; token: number; eventsBase?: string; es?: EventSource }>;
    start(roomId: string, eventsBase: string): void; // try backend acquire once
    observe(roomId: string, eventsBase: string): void; // observer mode (no lease)
    takeover(roomId: string): void; // explicit takeover
    release(roomId: string): void; // best-effort release via beacon
  };
};

export const useAppStore = create<Store>((set, get) => ({
  role: 'initiator',
  fetching: false,
  needsRefresh: false,
  plannerId: 'off',
  plannerMode: 'approve',
  configByPlanner: {},
  readyByPlanner: {},
  plannerSetup: { byPlanner: {} },
  catalogs: { llmModels: [], llmModelsLoaded: false, scenarioCache: new Map() },
  facts: [],
  seq: 0,
  hud: null,
  planNonce: 0,
  pendingKickoff: false,
  setupUi: {
    panel: 'collapsed' as 'open' | 'collapsed',
    lastPlannerId: '',
    autoCollapseOnReady: true,
  },
  knownMsg: new Set<string>(),
  attachmentsIndex: new Map(),
  composeApproved: new Set<string>(),
  inFlightSends: new Map(),
  sendErrorByCompose: new Map(),

  init(role, adapter, initialTaskId) {
    set({ role, adapter, taskId: initialTaskId, currentEpoch: undefined });
    if (initialTaskId) {
      try { get().setTaskId(initialTaskId); } catch {}
    }
  },

  setPlanner(id) { set({ plannerId: id }); },
  setPlannerMode(mode) {
    set({ plannerMode: mode });
  },

  setPlannerConfig(config, ready) {
    const pid = get().plannerId;
    try { console.debug('[store] setPlannerConfig', { pid, ready, hasConfig: !!config }); } catch {}
    set((s:any) => ({
      configByPlanner: { ...s.configByPlanner, [pid]: config },
      readyByPlanner: { ...s.readyByPlanner, [pid]: !!ready },
    }));
  },

  // New setup API actions
  setSetupDraft(plannerId, partialDraft) {
    set(s => {
      const row = s.plannerSetup.byPlanner[plannerId] || { valid: false, dirty: false };
      const draft = { ...(row.draft || {}), ...(partialDraft || {}) };
      const dirty = !shallowJsonEqual(draft, row.lastApplied);
      return { plannerSetup: { ...s.plannerSetup, byPlanner: { ...s.plannerSetup.byPlanner, [plannerId]: { ...row, draft, dirty } } } } as any;
    });
  },
  setSetupMeta(plannerId, meta) {
    set(s => {
      const row = s.plannerSetup.byPlanner[plannerId] || { valid: false, dirty: false };
      const next = { ...row, ...(meta || {}) };
      return { plannerSetup: { ...s.plannerSetup, byPlanner: { ...s.plannerSetup.byPlanner, [plannerId]: next } } } as any;
    });
  },
  applySetup(plannerId) {
    try { console.debug('[store] applySetup', { plannerId }); } catch {}
    const s = get();
    const row = s.plannerSetup.byPlanner[plannerId];
    if (!row?.valid || !row?.draft) return;
    set({
      configByPlanner: { ...s.configByPlanner, [plannerId]: row.draft },
      readyByPlanner:  { ...s.readyByPlanner,  [plannerId]: true },
      plannerSetup: {
        ...s.plannerSetup,
        byPlanner: { ...s.plannerSetup.byPlanner, [plannerId]: { ...row, lastApplied: row.draft, dirty: false } }
      }
    });
    get().reconfigurePlanner({ config: row.draft, ready: true, rewind: true });
  },
  async hydrateFromSeed(plannerId, seed) {
    const planner: any = resolvePlanner(plannerId);
    if (!planner?.hydrate) return;
    const cache = new Map<string, any>();
    const fetchJson = async (url: string) => fetchJsonCapped(url);
    const res = await planner.hydrate(seed, { fetchJson, cache });
    const config = (res as any)?.config ?? (res as any)?.full;
    const ready = (res as any)?.ready ?? !!config;
    if (config) {
      set(s => ({
        configByPlanner: { ...s.configByPlanner, [plannerId]: config },
        readyByPlanner: { ...s.readyByPlanner, [plannerId]: !!ready },
        plannerSetup: {
          ...s.plannerSetup,
          byPlanner: {
            ...s.plannerSetup.byPlanner,
            [plannerId]: {
              draft: config,
              lastApplied: config,
              valid: true,
              dirty: false,
              seed,
            }
          }
        }
      }));
    }
  },
  async ensureLlmModelsLoaded() {
    const s = get();
    if (s.catalogs.llmModelsLoaded) return;
    try {
      const arr = await fetchJsonCapped('/api/llm/providers');
      const providers = Array.isArray(arr) ? arr : [];
      // Prefer OpenRouter and hide mock to avoid noisy defaults
      const filtered = providers.filter((p:any)=>p && p.available!==false && p.name !== 'mock');
      const preferOpenRouter = filtered.filter((p:any)=>p.name === 'openrouter');
      const used = preferOpenRouter.length ? preferOpenRouter : filtered;
      const models = Array.from(new Set(used.flatMap((p:any)=>Array.isArray(p.models)?p.models:[]))).filter(Boolean) as string[];
      set({ catalogs: { ...get().catalogs, llmModels: models, llmModelsLoaded: true } });
    } catch {
      set({ catalogs: { ...get().catalogs, llmModels: [], llmModelsLoaded: true } });
    }
  },
  async loadScenario(url: string) {
    const s = get();
    const key = String(url || '');
    if (!key) throw new Error('Missing URL');
    const cached = s.catalogs.scenarioCache.get(key);
    if (cached) return cached;
    const raw = await fetchJsonCapped(key);
    const val = validateScenarioConfig(raw);
    if (!val.ok) throw new Error(val.errors.join('\n').slice(0, 1000));
    s.catalogs.scenarioCache.set(key, val.value);
    return val.value;
  },

  rewindJournal() {
    const s = get();
    const facts = s.facts || [];
    // Guard: avoid rewinding mid-send
    if (s.inFlightSends && (s.inFlightSends as Map<string, any>).size) {
      throw new Error('Cannot rewind while a send is in flight');
    }
    if (!facts.length) {
      set({ facts: [], seq: 0, composing: undefined, composeApproved: new Set(), inFlightSends: new Map(), sendErrorByCompose: new Map(), attachmentsIndex: new Map(), hud: null });
      return;
    }
    // Find last public event (remote_sent, remote_received, or status_changed)
    let cutIdx = -1;
    for (let i = facts.length - 1; i >= 0; --i) {
      const t = facts[i].type;
      if (t === 'remote_sent' || t === 'remote_received' || t === 'status_changed') { cutIdx = i; break; }
    }
    if (cutIdx < 0) {
      set({ facts: [], seq: 0, composing: undefined, composeApproved: new Set(), inFlightSends: new Map(), sendErrorByCompose: new Map(), attachmentsIndex: new Map(), hud: null });
      return;
    }
    const keep = facts.slice(0, cutIdx + 1);
    // Rebuild attachments index from survivors
    const idx = new Map<string, { mimeType: string; bytesBase64: string }>();
    for (const f of keep) {
      if (f.type === 'attachment_added') {
        idx.set((f as any).name, { mimeType: (f as any).mimeType, bytesBase64: (f as any).bytes });
      }
    }
    set({
      facts: keep,
      seq: keep.length ? keep[keep.length - 1].seq : 0,
      composing: undefined,
      composeApproved: new Set(),
      inFlightSends: new Map(),
      sendErrorByCompose: new Map(),
      attachmentsIndex: idx,
      hud: null,
    });
  },

  reconfigurePlanner({ config, ready, rewind }) {
    try { console.debug('[store] reconfigurePlanner', { plannerId: get().plannerId, ready, rewind }); } catch {}
    // Default: rewind to last public, unless explicitly disabled
    try {
      if (rewind === undefined || rewind === true) {
        get().rewindJournal();
      }
    } catch (e) {
      // Surface error via console; let caller decide UI handling
      try { console.warn('[reconfigurePlanner] rewind failed:', (e as any)?.message || e); } catch {}
      throw e;
    }
    // Apply FullConfig
    get().setPlannerConfig(config, ready);
    // Nudge planner controller; harness will also rebuild on seq change
    try { get().kickoffConversationWithPlanner(); } catch {}
    // Explicitly request a single replan after apply (exact, non-heuristic)
    try { get().requestReplan('apply'); } catch {}
  },

  setTaskId(taskId) {
    const prev = get().taskId;
    set({ taskId });
    if (taskId && taskId !== prev) {
      // New task → clear local journal state so histories don't mix
      try { console.debug('[store] switching taskId', { prev, next: taskId }); } catch {}
      set({ facts: [], seq: 0, knownMsg: new Set(), attachmentsIndex: new Map(), composing: undefined, composeApproved: new Set(), inFlightSends: new Map(), sendErrorByCompose: new Map() });
      try { get().startTicks(); } catch {}
      void get().fetchAndIngest();
    }
  },

  startTicks() {
    const { adapter, taskId, onTick } = get();
    if (!adapter || !taskId) return;
    const ac = new AbortController();
    // store cancellation token on window (simple demo); stop when page unloads
    (window as any).__ticksAbort?.abort?.();
    (window as any).__ticksAbort = ac;
    (async () => {
      try {
        for await (const _ of adapter.ticks(taskId, ac.signal)) {
          onTick();
        }
      } catch (err: any) {
        // Swallow aborts; log unexpected errors in dev
        if (!(err && (err.name === 'AbortError' || String(err).includes('AbortError')))) {
          try { console.debug('[ticks] ended', String(err?.message || err)); } catch {}
        }
      }
    })();
    window.addEventListener('beforeunload', () => { try { ac.abort(); } catch {} }, { once: true });
  },

  onTick() {
    const { fetching } = get();
    if (fetching) { set({ needsRefresh: true }); return; }
    get().fetchAndIngest();
  },

  async fetchAndIngest() {
    const { adapter, taskId } = get();
    if (!adapter || !taskId) return;
    const startedTaskId = taskId;
    set({ fetching: true });
    try {
      const snap = await adapter.snapshot(taskId);
      // If task switched while we were fetching, discard stale results
      if (get().taskId !== startedTaskId) return;
      if (!snap) return;
      const proposed = a2aToFacts(snap as any);
      stampAndAppend(set, get, proposed);
    } finally {
      set({ fetching: false });
    }
    const { needsRefresh } = get();
    if (needsRefresh) { set({ needsRefresh: false }); await get().fetchAndIngest(); }
  },

  // Legacy staging functions removed

  appendComposeIntent(text, attachments) {
    const composeId = rid('c');
    const pf = ({ type:'compose_intent', composeId, text, attachments } as ProposedFact);
    stampAndAppend(set, get, [pf as ProposedFact]);
    set({ composing: { composeId, text, attachments } });
    return composeId;
  },

  async sendCompose(composeId, nextState) {
    const { adapter, taskId, facts, attachmentsIndex } = get();
    if (!adapter) throw new Error('no adapter');
    const ci = [...facts].reverse().find((f): f is Extract<typeof f, { type:'compose_intent' }> => f.type === 'compose_intent' && f.composeId === composeId);
    if (!ci) throw new Error('compose not found');
    const parts: A2APart[] = [];
    parts.push({ kind:'text', text: ci.text } as any);
    if (Array.isArray(ci.attachments)) {
      for (const a of ci.attachments) {
        const rec = attachmentsIndex.get(a.name);
        if (rec) parts.push({ kind:'file', file:{ bytes: rec.bytesBase64, name: a.name, mimeType: rec.mimeType } } as any);
        else try { console.warn('[sendCompose] missing attachment bytes for', a.name); } catch {}
      }
    }
    const v = validateParts(parts);
    if (!v.ok) throw new Error(`invalid parts: ${v.reason}`);
    const messageId = rid('m');
    set((s:any)=>({
      composeApproved: new Set<string>(s.composeApproved as Set<string>).add(composeId),
      inFlightSends: new Map<string,{composeId:string}>(s.inFlightSends as Map<string,{composeId:string}>).set(messageId, { composeId }),
      sendErrorByCompose: (()=>{ const m = new Map<string,string>(s.sendErrorByCompose as Map<string,string>); m.delete(composeId); return m; })(),
    }));
    const ns = (nextState || (ci as any).nextStateHint || 'working') as A2ANextState;
    let lastErr: any;
    let result: { taskId: string; snapshot: any } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await adapter.send(parts, { taskId, messageId, nextState: ns }); lastErr = null; break; }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 200 * (2 ** attempt) + Math.random() * 100)); }
    }
    if (lastErr) {
      set((s:any)=>({
        composeApproved: (()=>{ const next = new Set<string>(s.composeApproved as Set<string>); next.delete(composeId); return next; })(),
        inFlightSends: (()=>{ const m = new Map<string,{composeId:string}>(s.inFlightSends as Map<string,{composeId:string}>); m.delete(messageId); return m; })(),
        sendErrorByCompose: new Map<string,string>(s.sendErrorByCompose as Map<string,string>).set(composeId, String((lastErr as any)?.message || 'Send failed'))
      }));
      throw lastErr;
    }

    // Success: adopt new taskId if starting a fresh conversation, start ticks, and ingest snapshot immediately
    const newTaskId = result?.taskId;
    if (!taskId && newTaskId) {
      set({ taskId: newTaskId });
      try { get().startTicks(); } catch {}
    }
    const snap = result?.snapshot;
    if (snap) {
      const proposed = a2aToFacts(snap as any);
      stampAndAppend(set, get, proposed);
    }
  },

  addUserGuidance(text) {
    const gid = rid('g');
    const pf = ({ type:'user_guidance', gid, text } as ProposedFact);
    stampAndAppend(set, get, [pf as ProposedFact]);
  },

  addUserAnswer(qid, text) {
    const pf = ({ type:'user_answer', qid: String(qid || ''), text: String(text || '') } as ProposedFact);
    stampAndAppend(set, get, [pf]);
  },

  dismissCompose(composeId: string) {
    const pf = ({ type:'compose_dismissed', composeId } as ProposedFact);
    stampAndAppend(set, get, [pf]);
  },

  kickoffConversationWithPlanner() {
    const { taskId, plannerId, readyByPlanner } = get();
    try { console.debug('[store] kickoffConversationWithPlanner called', { taskId: !!taskId, plannerId, ready: !!readyByPlanner[plannerId], adapter: !!get().adapter }); } catch {}
    if (taskId) return;
    if (plannerId === 'off') return;
    if (!readyByPlanner[plannerId]) return;
    const facts = get().facts;
    const hasAnyStatus = facts.some(f => f.type === 'status_changed');
    const unsent = findUnsentComposes(facts);
    if (hasAnyStatus || unsent.length) return;
    // If adapter/controller not ready yet, arm a pending kickoff
    if (!get().adapter) { try { console.debug('[store] kickoff: adapter not ready → arming latch'); } catch {} set({ pendingKickoff: true }); return; }
    // Latch kickoff intent
    try { get().requestKickoff('user-begin'); } catch {}
  },

  async cancelAndClear() {
    const { adapter, taskId } = get();
    try { if (adapter && taskId) await adapter.cancel(taskId); } catch {}
    try { (window as any).__ticksAbort?.abort?.(); } catch {}
    try { get().detachBackchannel(); } catch {}
    set({
      taskId: undefined,
      currentEpoch: undefined,
      seq: 0,
      facts: [],
      knownMsg: new Set<string>(),
      attachmentsIndex: new Map<string,{mimeType:string;bytesBase64:string}>(),
      composeApproved: new Set<string>(),
      inFlightSends: new Map<string,{composeId:string}>(),
      sendErrorByCompose: new Map<string,string>(),
      hud: null,
      fetching: false,
      needsRefresh: false,
      composing: undefined,
    });
  },

  // --- backchannel management (responder) ---
  attachBackchannel(tasksUrl: string) {
    get().detachBackchannel();
    if (!tasksUrl) return;
    const es = new EventSource(tasksUrl);
    (window as any).__tasksUrlES = es;
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        const msg = payload.result;
        if (msg?.type === 'subscribe' && msg.taskId) {
          const epoch = Number(msg.epoch ?? NaN);
          const cur = useAppStore.getState().currentEpoch;
          if (!Number.isFinite(epoch) || cur == null || epoch > cur) {
            try { useAppStore.setState({ currentEpoch: Number.isFinite(epoch) ? epoch : undefined }); } catch {}
            useAppStore.getState().setTaskId(String(msg.taskId));
          }
        }
      } catch {}
    };
    es.onerror = () => {
      // optional: UI status integration could go here
    };
  },
  detachBackchannel() { try { ((window as any).__tasksUrlES as EventSource | undefined)?.close?.(); } catch {} finally { try { delete (window as any).__tasksUrlES; } catch {} } },

  uiStatus() {
    const { facts, taskId, role } = get();
    if (!taskId) return role === 'initiator' ? "Send a message to begin a new task" : "Waiting for new task";
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'status_changed') return f.a2a;
    }
    return "submitted";
  },
  append(batch, opts) {
    const baseSeq = typeof opts?.casBaseSeq === 'number' ? opts!.casBaseSeq : get().seq;
    try { console.debug('[store] append called', { baseSeq, head:get().seq, count: batch.length, types: batch.map(b=>b.type) }); } catch {}
    if ((get().seq || 0) !== baseSeq) return false;
    stampAndAppend(set, get, batch);
    try { get().ackKickoffIfPending(); } catch {}
    try {
      const mode = get().plannerMode;
      if (mode === 'auto') {
        if (runawayGuardActive(get().facts.length)) {
          try { get().setHud('waiting', `🧊 Runaway guard: auto-send disabled (entries=${get().facts.length} ≥ cap=${JOURNAL_HARD_CAP})`); } catch {}
          return true;
        }
        for (const pf of batch) {
          if (pf && pf.type === 'compose_intent') {
            const ci = pf as any as { composeId:string; nextStateHint?: A2ANextState };
            queueMicrotask(() => { try { void get().sendCompose(ci.composeId, (ci.nextStateHint || 'working') as A2ANextState); } catch {} });
          }
        }
      }
    } catch {}
    return true;
  },
  head() { return get().seq || 0; },
  setHud(phase, label, p) { set({ hud: { phase, label, p } }); },
  requestReplan(_reason) { set(s => ({ planNonce: (s.planNonce || 0) + 1 })); },
  requestKickoff(reason) {
    try { console.debug('[store] requestKickoff', { reason }); } catch {}
    set({ pendingKickoff: true });
    set(s => ({ planNonce: (s.planNonce || 0) + 1 }));
  },
  ackKickoffIfPending() {
    if (get().pendingKickoff) {
      try { console.debug('[store] ackKickoffIfPending: clearing latch'); } catch {}
      set({ pendingKickoff: false });
    }
  },

  // Setup UI state machine
  openSetup() { set(s => ({ setupUi: { ...s.setupUi, panel: 'open' } })); },
  collapseSetup() { set(s => ({ setupUi: { ...s.setupUi, panel: 'collapsed' } })); },
  onPlannerSelected(newPid, readyNow) {
    set(s => ({
      setupUi: {
        ...s.setupUi,
        lastPlannerId: newPid,
        panel: readyNow ? 'collapsed' : 'open',
      }
    }));
  },
  onPlannerReadyFlip(readyNow) {
    set(s => {
      if (readyNow && s.setupUi.autoCollapseOnReady) {
        return { setupUi: { ...s.setupUi, panel: 'collapsed' } };
      }
      return s;
    });
  },
  onApplyClicked() {
    set(s => ({ setupUi: { ...s.setupUi, panel: 'collapsed' } }));
  },

  // Rooms slice implementation
  rooms: {
    byId: {},
    start(roomId: string, eventsBase: string) {
      const s = get();
      const byId = { ...(s.rooms.byId || {}) } as any;
      const token = (byId[roomId]?.token || 0) + 1;
      // Close prior stream if present
      try { byId[roomId]?.es?.close?.() } catch {}
      byId[roomId] = { ...(byId[roomId]||{}), connState:'connecting', token, eventsBase, es: undefined };
      set((st:any)=>({ rooms: { ...st.rooms, byId } }));
      // Attempt rebind if we have a stored lease for this room
      let url = `${eventsBase}?mode=backend`;
      try {
        const stored = sessionStorage.getItem(`lease:${roomId}`);
        if (stored && stored.trim()) url = `${eventsBase}?mode=backend&leaseId=${encodeURIComponent(stored)}`;
      } catch {}
      const es = new EventSource(url);
      es.onmessage = (ev) => {
        const cur = get().rooms.byId[roomId]; if (!cur || cur.token !== token) return;
        try {
          const payload = JSON.parse(ev.data);
          const msg = payload?.result;
          if (msg?.type === 'backend-granted') {
            // Record lease, set adapter header, write-through to sessionStorage
            const leaseId = String(msg.leaseId || '');
            try { get().adapter && (get().adapter as any)?.setBackendLease?.(leaseId); } catch {}
            try { sessionStorage.setItem(`lease:${roomId}`, leaseId); } catch {}
            const byId2 = { ...(get().rooms.byId) } as any; byId2[roomId] = { ...byId2[roomId], leaseId, connState:'connected', es };
            set((st:any)=>({ rooms: { ...st.rooms, byId: byId2 } }));
          } else if (msg?.type === 'backend-denied') {
            const byId2 = { ...(get().rooms.byId) } as any; byId2[roomId] = { ...byId2[roomId], connState:'observing', es };
            set((st:any)=>({ rooms: { ...st.rooms, byId: byId2 } }));
          } else if (msg?.type === 'backend-revoked') {
            try { get().adapter && (get().adapter as any)?.setBackendLease?.(null); } catch {}
            try { sessionStorage.removeItem(`lease:${roomId}`) } catch {}
            const byId2 = { ...(get().rooms.byId) } as any; byId2[roomId] = { ...byId2[roomId], leaseId: undefined, connState:'revoked', es };
            set((st:any)=>({ rooms: { ...st.rooms, byId: byId2 } }));
          } else if (msg?.type === 'subscribe' && msg.taskId) {
            try { get().setTaskId(String(msg.taskId)) } catch {}
          }
        } catch {}
      };
      es.onerror = () => {};
      // No es close tracking; a new start bumps token and supersedes this stream
    },
    observe(roomId: string, eventsBase: string) {
      const s = get();
      const byId = { ...(s.rooms.byId || {}) } as any;
      const token = (byId[roomId]?.token || 0) + 1;
      try { byId[roomId]?.es?.close?.() } catch {}
      byId[roomId] = { ...(byId[roomId]||{}), connState:'observing', token, eventsBase, es: undefined };
      set((st:any)=>({ rooms: { ...st.rooms, byId } }));
      const url = `${eventsBase}?mode=observer`;
      const es = new EventSource(url);
      es.onmessage = () => {};
      es.onerror = () => {};
      const byId2 = { ...(get().rooms.byId) } as any; byId2[roomId] = { ...byId2[roomId], es };
      set((st:any)=>({ rooms: { ...st.rooms, byId: byId2 } }));
    },
    takeover(roomId: string) {
      const cur = get().rooms.byId[roomId]; if (!cur?.eventsBase) return;
      const token = (cur.token || 0) + 1;
      try { cur.es?.close?.() } catch {}
      const byId = { ...(get().rooms.byId) } as any; byId[roomId] = { ...cur, connState:'connecting', token, es: undefined };
      set((st:any)=>({ rooms: { ...st.rooms, byId } }));
      const es = new EventSource(`${cur.eventsBase}?mode=backend&takeover=1`);
      es.onmessage = (ev) => {
        const live = get().rooms.byId[roomId]; if (!live || live.token !== token) return;
        try {
          const payload = JSON.parse(ev.data);
          const msg = payload?.result;
          if (msg?.type === 'backend-granted') {
            const leaseId = String(msg.leaseId || '');
            try { get().adapter && (get().adapter as any)?.setBackendLease?.(leaseId); } catch {}
            try { sessionStorage.setItem(`lease:${roomId}`, leaseId); } catch {}
            const byId2 = { ...(get().rooms.byId) } as any; byId2[roomId] = { ...byId2[roomId], leaseId, connState:'connected', es };
            set((st:any)=>({ rooms: { ...st.rooms, byId: byId2 } }));
          } else if (msg?.type === 'backend-denied') {
            const byId2 = { ...(get().rooms.byId) } as any; byId2[roomId] = { ...byId2[roomId], connState:'observing', es };
            set((st:any)=>({ rooms: { ...st.rooms, byId: byId2 } }));
          }
        } catch {}
      }
      es.onerror = () => {};
    },
    release(roomId: string) {
      const cur = get().rooms.byId[roomId]; if (!cur?.leaseId) return;
      try {
        const u = new URL(window.location.origin);
        const rel = `${u.origin}/api/rooms/${encodeURIComponent(roomId)}/backend/release`;
        const fd = new FormData(); fd.set('leaseId', cur.leaseId);
        navigator.sendBeacon(rel, fd);
      } catch {}
      try { sessionStorage.removeItem(`lease:${roomId}`) } catch {}
      try { cur.es?.close?.() } catch {}
      const byId = { ...(get().rooms.byId) } as any; byId[roomId] = { ...byId[roomId], leaseId: undefined, connState:'observing', es: undefined };
      set((st:any)=>({ rooms: { ...st.rooms, byId } }));
    }
  },
}));

// --- helpers ---

function shallowJsonEqual(a: any, b: any) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return a === b; }
}

function stampAndAppend(set: any, get: any, proposed: ProposedFact[]) {
  if (!proposed.length) return;
  // Dedup BEFORE stamping: skip known messageIds so we don't burn seq numbers
  const known = get().knownMsg as Set<string>;
  const existingNames = new Set<string>(get().facts.filter((f:Fact)=>f.type==='attachment_added').map((f:any)=>f.name));
  // Track latest known status to drop redundant status_changed events
  let currStatus: string | undefined = (() => {
    const facts: Fact[] = get().facts;
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'status_changed') return (f as any).a2a as string;
    }
    return undefined;
  })();
  const filtered: ProposedFact[] = [];
  for (const p of proposed) {
    if (p.type === 'remote_received' || p.type === 'remote_sent') {
      const mid = (p as any).messageId;
      if (mid && known.has(mid)) continue;
      if (mid) known.add(mid);
    }
    if (p.type === 'attachment_added') {
      // Do not rename; allow duplicates. Track names only for consistency.
      existingNames.add((p as any).name);
    }
    if (p.type === 'status_changed') {
      const st = (p as any).a2a as string;
      if (typeof st === 'string' && st === currStatus) {
        // Drop redundant status_changed
        continue;
      }
      currStatus = st;
    }
    filtered.push(p);
  }
  // Note: We no longer auto-dismiss older drafts on send; planner gating is handled elsewhere
  if (!filtered.length) return;
  const seq0 = get().seq || 0;
  const ts = nowIso();
  const stamped = filtered.map((p,i) => ({ ...(p as any), seq: seq0 + 1 + i, ts, id: rid('f') })) as Fact[];
  const attachmentsIndex = new Map<string,{mimeType:string;bytesBase64:string}>(get().attachmentsIndex as Map<string,{mimeType:string;bytesBase64:string}>);
  const inflight = new Map<string,{composeId:string}>(get().inFlightSends as Map<string,{composeId:string}>);
  const approved = new Set<string>(get().composeApproved as Set<string>);
  for (const f of stamped) {
    if (f.type === 'attachment_added') {
      const nm = (f as any).name as string;
      if (!attachmentsIndex.has(nm)) attachmentsIndex.set(nm, { mimeType: (f as any).mimeType, bytesBase64: (f as any).bytes });
    }
    if (f.type === 'remote_sent') {
      const link = inflight.get((f as any).messageId);
      if (link) {
        (f as any).composeId = link.composeId;
        inflight.delete((f as any).messageId);
      }
    }
  }
  set((s:any)=>({ facts: [...s.facts, ...stamped], seq: seq0 + stamped.length, attachmentsIndex, knownMsg: known, inFlightSends: inflight, composeApproved: approved }));
}

// Helper functions
function findUnsentComposes(facts: Fact[]): Array<{ composeId: string; nextStateHint?: A2ANextState }> {
  // consider compose 'unsent' only if not dismissed and no remote_sent after it
  const dismissed = new Set<string>(facts.filter(f=>f.type==='compose_dismissed').map((f:any)=>f.composeId));
  const out: Array<{ composeId: string; nextStateHint?: A2ANextState }> = [];
  for (let i = facts.length - 1; i >= 0; --i) {
    const f = facts[i];
    if (f.type === 'remote_sent') break;
    if (f.type === 'compose_intent') {
      const ci = f as any;
      if (!dismissed.has(ci.composeId)) out.unshift({ composeId: ci.composeId, nextStateHint: ci.nextStateHint });
    }
  }
  return out;
}
