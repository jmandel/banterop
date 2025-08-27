import { create } from 'zustand';
import type { A2APart, A2AStatus } from '../../shared/a2a-types';
import type { Fact, ProposedFact, AttachmentMeta } from '../../shared/journal-types';
import type { PlannerApplied } from '../planner/types';
import type { TransportAdapter } from '../transports/types';
import { a2aToFacts } from '../../shared/a2a-translator';
import { validateParts } from '../../shared/parts-validator';
import { nowIso, rid } from '../../shared/core';
import { encodeSetup } from '../../shared/setup-hash';
// import { uniqueName } from '../../shared/a2a-helpers';
// Planner registry for defaults
// PlannerRegistry no longer used for staging; config handled by planner stores

type Role = 'initiator'|'responder';

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
  appliedByPlanner: Record<string, any>;
  readyByPlanner: Record<string, boolean>;
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
  setPlannerApplied(applied: PlannerApplied | any, ready: boolean): void;
  // legacy staging functions removed; planners with config stores persist directly
  appendComposeIntent(text: string, attachments?: AttachmentMeta[]): string;
  sendCompose(composeId: string, finality: 'none'|'turn'|'conversation'): Promise<void>;
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
};

export const useAppStore = create<Store>((set, get) => ({
  role: 'initiator',
  fetching: false,
  needsRefresh: false,
  plannerId: 'off',
  plannerMode: 'approve',
  appliedByPlanner: {},
  readyByPlanner: {},
  facts: [],
  seq: 0,
  hud: null,
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
    set({ plannerId: id });
  },
  setPlannerMode(mode) { set({ plannerMode: mode }); },

  setPlannerApplied(applied, ready) {
    const pid = get().plannerId;
    set((s:any) => ({
      appliedByPlanner: { ...s.appliedByPlanner, [pid]: applied },
      readyByPlanner: { ...s.readyByPlanner, [pid]: ready },
    }));
    // Reflect setup in URL hash for deep links (UI-agnostic)
    try {
      const mode = get().plannerMode;
      // Sanitize large blobs like resolvedScenario
      let appliedForUrl: any = applied;
      try {
        if (pid === 'scenario-v0.3') {
          const slim: any = {};
          const scenUrl = String((applied as any)?.scenarioUrl || '');
          if (scenUrl) slim.scenarioUrl = scenUrl;
          const model = String((applied as any)?.model || '');
          if (model) slim.model = model;
          const myAgentId = String((applied as any)?.myAgentId || '');
          if (myAgentId) slim.myAgentId = myAgentId;
          const tools = (applied as any)?.enabledTools;
          if (Array.isArray(tools) && tools.length) slim.enabledTools = tools;
          const coreTools = (applied as any)?.enabledCoreTools;
          if (Array.isArray(coreTools) && coreTools.length) slim.enabledCoreTools = coreTools;
          const maxSteps = Number((applied as any)?.maxInlineSteps);
          if (Number.isFinite(maxSteps) && maxSteps > 0) slim.maxInlineSteps = maxSteps;
          appliedForUrl = slim;
        } else if (applied && typeof applied === 'object') {
          // Generic: drop known heavy keys if present
          const { resolvedScenario, ...rest } = applied as any;
          appliedForUrl = rest;
        }
      } catch {}
      const setup = { planner: { id: pid, mode, ready: true, applied: appliedForUrl } };
      const hash = encodeSetup(setup);
      if (hash) try { window.location.hash = hash; } catch {}
    } catch {}
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
    set({ fetching: true });
    try {
      const snap = await adapter.snapshot(taskId);
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

  async sendCompose(composeId, finality) {
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
    const fin = (finality || ci.finalityHint || 'turn') as 'none'|'turn'|'conversation';
    let lastErr: any;
    let result: { taskId: string; snapshot: any } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await adapter.send(parts, { taskId, messageId, finality: fin }); lastErr = null; break; }
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
        for (const pf of batch) {
          if (pf && pf.type === 'compose_intent') {
            const ci = pf as any as { composeId:string; finalityHint?: 'none'|'turn'|'conversation' };
            queueMicrotask(() => { try { void get().sendCompose(ci.composeId, (ci.finalityHint || 'turn') as any); } catch {} });
          }
        }
      }
    } catch {}
    return true;
  },
  head() { return get().seq || 0; },
  setHud(phase, label, p) { set({ hud: { phase, label, p } }); },
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

// legacy ingest removed; use a2aToFacts + stampAndAppend

function findUnsentComposes(facts: Fact[]): Array<{ composeId: string; finalityHint?: 'none'|'turn'|'conversation' }> {
  // consider compose 'unsent' only if not dismissed and no remote_sent after it
  const dismissed = new Set<string>(facts.filter(f=>f.type==='compose_dismissed').map((f:any)=>f.composeId));
  const out: Array<{ composeId: string; finalityHint?: 'none'|'turn'|'conversation' }> = [];
  for (let i = facts.length - 1; i >= 0; --i) {
    const f = facts[i];
    if (f.type === 'remote_sent') break;
    if (f.type === 'compose_intent') {
      const ci = f as any;
      if (!dismissed.has(ci.composeId)) out.unshift({ composeId: ci.composeId, finalityHint: ci.finalityHint });
    }
  }
  return out;
}
