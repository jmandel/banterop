import { create } from 'zustand';
import type { SavedField, PlannerConfigStore } from '../planner/config/types';
import type { A2APart, A2AStatus, A2ANextState } from '../../shared/a2a-types';
import type { Fact, ProposedFact, AttachmentMeta } from '../../shared/journal-types';
import type { TransportAdapter } from '../transports/types';
import { a2aToFacts } from '../../shared/a2a-translator';
import { validateParts } from '../../shared/parts-validator';
import { nowIso, rid } from '../../shared/core';
import { resolvePlanner } from '../planner/registry';
import { makeChitchatProvider, DEFAULT_CHITCHAT_ENDPOINT } from '../../shared/llm-provider';

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
  savedFieldsByPlanner: Record<string, SavedField[] | undefined>;
  // new config system
  configStores: Record<string, PlannerConfigStore>;
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
  setPlannerSavedFields(saved: SavedField[]): void;
  // new config system actions
  onConfigChange(plannerId: string, config: any): void;
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
};

export const useAppStore = create<Store>((set, get) => ({
  role: 'initiator',
  fetching: false,
  needsRefresh: false,
  plannerId: 'off',
  plannerMode: 'approve',
  configByPlanner: {},
  readyByPlanner: {},
  savedFieldsByPlanner: {},
  configStores: {},
  facts: [],
  seq: 0,
  hud: null,
  planNonce: 0,
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

  setPlanner(id) {
    const prevId = get().plannerId;
    console.log('[AppStore] setPlanner:', { from: prevId, to: id });

    // Switch planner id
    set({ plannerId: id });

    // Clean up the previous planner's config store to avoid leaks
    if (prevId && prevId !== id) {
      const prevStore = get().configStores[prevId];
      if (prevStore && typeof prevStore.destroy === 'function') {
        try { prevStore.destroy(); } catch {}
      }
      set(s => {
        const next = { ...s.configStores };
        delete next[prevId];
        return { configStores: next };
      });
    }

    // If switching to a planner that supports config, create the config store
    if (id !== 'off' && id !== prevId) {
      const planner = resolvePlanner(id);
      console.log('[AppStore] setPlanner: resolved planner:', {
        id,
        planner: !!planner,
        hasCreateConfigStore: !!(planner && planner.createConfigStore)
      });

      if (planner.createConfigStore) {
        const llm = makeChitchatProvider(DEFAULT_CHITCHAT_ENDPOINT);
        console.log('[AppStore] setPlanner: creating config store for', id);

        const configStore = planner.createConfigStore({
          llm,
          onConfigChange: (config) => {
            console.log('[AppStore] onConfigChange called:', { id, config });
            get().onConfigChange(id, config);
          }
        });

        console.log('[AppStore] setPlanner: config store created:', !!configStore);

        set(s => ({
          configStores: { ...s.configStores, [id]: configStore }
        }));

        console.log('[AppStore] setPlanner: config store stored in state');

        // Initialize the config store (this will trigger model loading)
        console.log('[AppStore] setPlanner: initializing config store');
        // The config store facade doesn't expose getState, so we need to initialize it differently
        // For now, we'll initialize it when it's first accessed by the UI
        console.log('[AppStore] setPlanner: config store ready for initialization');
      }
    }
  },
  setPlannerMode(mode) {
    set({ plannerMode: mode });
  },

  setPlannerConfig(config, ready) {
    const pid = get().plannerId;
    set((s:any) => ({
      configByPlanner: { ...s.configByPlanner, [pid]: config },
      readyByPlanner: { ...s.readyByPlanner, [pid]: !!ready },
    }));
  },

  setPlannerSavedFields(saved) {
    const pid = get().plannerId;
    set((s:any) => ({ savedFieldsByPlanner: { ...s.savedFieldsByPlanner, [pid]: saved } }));
  },

  // New config system actions
  onConfigChange(plannerId, config) {
    // Mirror working config live for URL sync / previews,
    // but do NOT flip readiness here — Save & Apply handles that.
    set(s => ({
      configByPlanner: { ...s.configByPlanner, [plannerId]: config }
    }));
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
    // Find last public event (remote_sent or remote_received)
    let cutIdx = -1;
    for (let i = facts.length - 1; i >= 0; --i) {
      const t = facts[i].type;
      if (t === 'remote_sent' || t === 'remote_received') { cutIdx = i; break; }
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
    if (taskId) return;
    if (plannerId === 'off') return;
    if (!readyByPlanner[plannerId]) return;
    const facts = get().facts;
    const hasAnyStatus = facts.some(f => f.type === 'status_changed');
    const unsent = findUnsentComposes(facts);
    if (hasAnyStatus || unsent.length) return;
    stampAndAppend(set, get, [{ type:'status_changed', a2a:'input-required' } as ProposedFact]);
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
    if ((get().seq || 0) !== baseSeq) return false;
    stampAndAppend(set, get, batch);
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
}));

// --- helpers ---

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
  // When we send a new outgoing message, dismiss any prior suggested drafts
  try {
    if (filtered.some(p => p && p.type === 'remote_sent')) {
      const facts: Fact[] = get().facts || [];
      const dismissed = new Set<string>(facts.filter(f=>f.type==='compose_dismissed').map((f:any)=>String((f as any).composeId||'')));
      for (const f of facts) {
        if (f.type === 'compose_intent') {
          const cid = String((f as any).composeId || '');
          if (cid && !dismissed.has(cid)) {
            filtered.push({ type:'compose_dismissed', composeId: cid } as any as ProposedFact);
            dismissed.add(cid);
          }
        }
      }
    }
  } catch {}
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
