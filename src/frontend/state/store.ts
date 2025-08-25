import { create } from 'zustand';
import type { A2APart, A2AMessage, A2AStatus } from '../../shared/a2a-types';
import type { Fact, ProposedFact, AttachmentMeta } from '../../shared/journal-types';
import type { TransportAdapter, TransportSnapshot } from '../transports/types';

function nowIso() { return new Date().toISOString(); }
function rid(prefix?:string) { return `${prefix||'id'}-${crypto.randomUUID()}`; }
function textOf(parts: A2APart[]) { return (parts||[]).filter(p=>p.kind==='text').map((p:any)=>p.text).join('\n'); }

type Role = 'initiator'|'responder';

export type Store = {
  // meta
  role: Role;
  taskId?: string;
  adapter?: TransportAdapter;
  fetching: boolean;
  needsRefresh: boolean;
  // journal
  facts: Fact[];
  seq: number;
  // composer
  composing?: { composeId: string; text: string; attachments?: AttachmentMeta[] };
  pending: Record<string, { composeId?: string }>; // messageId -> composeId
  // helpers
  knownMsg: Record<string, 1>;
  // actions
  init(role: Role, adapter: TransportAdapter, initialTaskId?: string): void;
  setTaskId(taskId?: string): void;
  startTicks(): void;
  onTick(): void;
  fetchAndIngest(): Promise<void>;
  appendComposeIntent(text: string, attachments?: AttachmentMeta[]): string;
  approveAndSend(composeId: string, finality: 'none'|'turn'|'conversation'): Promise<void>;
  addUserGuidance(text: string): void;
  cancelAndClear(): Promise<void>;
  // selectors (as functions for convenience)
  uiStatus(): string;
};

export const useAppStore = create<Store>((set, get) => ({
  role: 'initiator',
  fetching: false,
  needsRefresh: false,
  facts: [],
  seq: 0,
  pending: {},
  knownMsg: {},

  init(role, adapter, initialTaskId) {
    set({ role, adapter, taskId: initialTaskId });
    if (initialTaskId) {
      try { get().setTaskId(initialTaskId); } catch {}
    }
  },

  setTaskId(taskId) {
    const prev = get().taskId;
    set({ taskId });
    if (taskId && taskId !== prev) {
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
      for await (const _ of adapter.ticks(taskId, ac.signal)) {
        onTick();
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
      ingestSnapshotIntoJournal(snap, set, get);
    } finally {
      set({ fetching: false });
    }
    const { needsRefresh } = get();
    if (needsRefresh) { set({ needsRefresh: false }); await get().fetchAndIngest(); }
  },

  appendComposeIntent(text, attachments) {
    const composeId = rid('c');
    const pf = ({ type:'compose_intent', composeId, text, attachments } as ProposedFact);
    stampAndAppend([pf as ProposedFact], set, get);
    set({ composing: { composeId, text, attachments } });
    return composeId;
  },

  async approveAndSend(composeId, finality) {
    const { adapter, taskId, facts, pending } = get();
    if (!adapter) return;
    // resolve compose
    const ci = [...facts].reverse().find((f): f is Extract<typeof f, { type:'compose_intent' }> => f.type === 'compose_intent' && f.composeId === composeId);
    if (!ci) return;
    // build parts
    const parts: A2APart[] = [];
    parts.push({ kind:'text', text: ci.text, metadata: { 'https://chitchat.fhir.me/a2a-ext': { finality } } });
    if (Array.isArray(ci.attachments)) {
      for (const a of ci.attachments) {
        const resolved = resolveAttachmentBytes(facts, a.name);
        if (resolved) parts.push({ kind:'file', file: { bytes: resolved.bytes, name: a.name, mimeType: resolved.mimeType } });
      }
    }
    const messageId = rid('m');
    const { taskId: newTaskId, snapshot } = await adapter.send(parts, { taskId, messageId, finality });
    // update local task id via setter to bootstrap driver
    get().setTaskId(newTaskId);
    set({ pending: { ...pending, [messageId]: { composeId } } });
    ingestSnapshotIntoJournal(snapshot, set, get);
    // setTaskId already started ticks and fetched
  },

  addUserGuidance(text) {
    const gid = rid('g');
    const pf = ({ type:'user_guidance', gid, text } as ProposedFact);
    stampAndAppend([pf as ProposedFact], set, get);
  },

  async cancelAndClear() {
    const { adapter, taskId } = get();
    if (adapter && taskId) { try { await adapter.cancel(taskId); } catch {} }
    // clear local state
    set({ taskId: undefined, facts: [], seq: 0, pending: {}, knownMsg: {}, composing: undefined });
  },

  uiStatus() {
    const { facts, taskId } = get();
    if (!taskId) return "Waiting for new task";
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'status_changed') return f.a2a;
    }
    return "submitted";
  }
}));

// --- helpers ---

function stampAndAppend(batch: ProposedFact[], set: any, get: any) {
  const seq0 = get().seq || 0;
  const now = nowIso();
  const stamped = batch.map((f: ProposedFact, i: number) => Object.assign({}, f, { seq: seq0 + 1 + i, ts: now, id: rid('f'), vis: (f.type === 'remote_received' || f.type === 'remote_sent') ? 'public' : 'private' }));
  set((s:any) => ({ facts: [...s.facts, ...stamped], seq: seq0 + stamped.length }));
}

function resolveAttachmentBytes(facts: Fact[], name: string): { mimeType: string; bytes: string } | null {
  for (let i = facts.length - 1; i >= 0; --i) {
    const f = facts[i];
    if (f.type === 'attachment_added' && f.name === name) return { mimeType: f.mimeType, bytes: f.bytes };
  }
  return null;
}

function ingestSnapshotIntoJournal(snap: TransportSnapshot, set: any, get: any) {
  const facts: Fact[] = get().facts;
  const knownMsg: Record<string,1> = { ...(get().knownMsg || {}) };
  const pending = { ...(get().pending || {}) };

  // status_changed
  const lastStatus = (() => { for (let i=facts.length-1;i>=0;--i) { const f = facts[i]; if (f.type==='status_changed') return f.a2a; } return undefined; })();
  const st = snap.status?.state || 'submitted';
  if (st !== lastStatus) {
    stampAndAppend([{ type:'status_changed', a2a: st } as ProposedFact], set, get);
  }

  // messages in order
  const all: A2AMessage[] = [];
  if (Array.isArray(snap.history)) all.push(...snap.history);
  if (snap.status?.message) all.push(snap.status.message);
  for (const m of all) {
    if (!m || !m.messageId || knownMsg[m.messageId]) continue;
    knownMsg[m.messageId] = 1;

    // Attachments: create attachment_added facts for inline bytes
    const attMeta: AttachmentMeta[] = [];
    for (const p of (m.parts || [])) {
      if (p.kind === 'file' && 'bytes' in p.file && typeof p.file.bytes === 'string') {
        const name = p.file.name || `${p.file.mimeType || 'application/octet-stream'}-${Math.random().toString(36).slice(2,7)}.bin`;
        const bytes = p.file.bytes;
        const mime = p.file.mimeType || 'application/octet-stream';
        // avoid duplicate attachment names
        const unique = uniqueName(name, facts);
        stampAndAppend([{ type:'attachment_added', name: unique, mimeType: mime, bytes, origin: 'inbound' } as ProposedFact], set, get);
        attMeta.push({ name: unique, mimeType: mime, origin:'inbound' });
      }
    }

    if (m.role === 'agent') {
      stampAndAppend([{ type:'remote_received', messageId: m.messageId, text: textOf(m.parts||[]), attachments: attMeta.length ? attMeta : undefined } as ProposedFact], set, get);
    } else {
      const link = pending[m.messageId]; // echo of our send
      stampAndAppend([{ type:'remote_sent', messageId: m.messageId, text: textOf(m.parts||[]), attachments: attMeta.length?attMeta:undefined, composeId: link?.composeId } as ProposedFact], set, get);
      if (link) delete pending[m.messageId];
    }
  }

  set({ knownMsg, pending });
}

function uniqueName(name: string, facts: Fact[]): string {
  if (!facts.some(f => f.type==='attachment_added' && f.name===name)) return name;
  const stem = name.replace(/\.[^./]+$/, '');
  const ext = (name.match(/\.[^./]+$/) || [''])[0];
  let i = 2;
  while (facts.some(f => f.type==='attachment_added' && f.name===`${stem} (${i})${ext}`)) i++;
  return `${stem} (${i})${ext}`;
}
