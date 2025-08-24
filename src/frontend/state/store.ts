import { create } from 'zustand';
import type { A2APart, A2ATask, A2AStatus, A2AMessage } from '../../shared/a2a-types';
import type { Fact, ProposedFact, AttachmentMeta } from '../../shared/journal-types';
import { A2AClient, type FrameResult } from '../transports/a2a-client';
import type { TransportAdapter, TransportSnapshot } from '../transports/types';
import { A2ATransport } from '../transports/a2a-adapter';

export type Role = 'initiator' | 'responder';

type Journal = {
  seq: number;
  facts: Fact[];
};

type StatusLike = A2AStatus | 'waiting-for-task';

type StoreState = {
  endpoint: string;
  role: Role;
  taskId?: string;
  pairId?: string;
  status: StatusLike;
  journal: Journal;
  ticksRunning: boolean;
  sending: boolean;
  transport?: TransportAdapter;

  // actions
  configure(endpoint: string, role: Role): void;
  ingestFrame(frame: FrameResult): void;
  sendManual(text: string, finality: 'none'|'turn'|'conversation'): Promise<void>;
  cancelTask(): Promise<void>;
  startTicks(taskId?: string): void;
  stopTicks(): void;
  bootResponder(pairId: string): void;
  stopBackchannel(): void;
};

function nowIso() { return new Date().toISOString(); }
function rid(prefix?:string) { return `${prefix||'id'}-${crypto.randomUUID()}`; }

export const useStore = create<StoreState>((set, get) => {
  let client: A2AClient | null = null;
  let ticksAborter: AbortController | null = null;
  let ticker: { taskId: string; ac: AbortController; stopped: boolean } | null = null;
  let bc: { pairId: string; ac: AbortController } | null = null;
  let pairCursor: number | undefined = undefined;

  function ensureClient(): A2AClient {
    const ep = get().endpoint;
    if (!client || (client as any)._ep !== ep) {
      client = new A2AClient(ep);
      (client as any)._ep = ep;
    }
    return client!;
  }

  async function fetchSnapshot(taskId: string) {
    const t = get().transport;
    if (!t) return;
    const snap = await t.snapshot(taskId);
    if (snap) ingestTaskSnapshot(snap as any);
  }

  function append(f: ProposedFact, vis:'public'|'private') {
    set((s) => {
      const seq = s.journal.seq + 1;
      const stamped = Object.assign({}, f, { seq, ts: nowIso(), id: rid('f'), vis }) as Fact;
      return { journal: { seq, facts: [...s.journal.facts, stamped] } };
    });
  }

  function ingestTaskSnapshot(task: A2ATask | TransportSnapshot) {
    // Status
    set({ status: task.status?.state || 'submitted' });
    // Record latest message and tail
    const tail = Array.isArray(task.history) ? task.history : [];
    const latest = (task as any).status?.message ? [(task as any).status.message] : [];
    const all = [...tail, ...latest];
    const seen = new Set(get().journal.facts.filter(f => (f as any).messageId).map((f:any) => f.messageId));
    for (const m of all) {
      if (!m?.messageId || seen.has(m.messageId)) continue;
      // attachments: if file bytes present, append attachment_added privately
      const attachments: AttachmentMeta[] = [];
      for (const p of (m.parts || [])) {
        if (p.kind === 'file' && 'bytes' in p.file && typeof (p.file as any).bytes === 'string') {
          const name = (p.file as any).name || `${(p.file as any).mimeType || 'application/octet-stream'}-${Math.random().toString(36).slice(2,7)}.bin`;
          const mimeType = (p.file as any).mimeType || 'application/octet-stream';
          append({ type:'attachment_added', name, mimeType, bytes:(p.file as any).bytes, origin:'inbound' }, 'private');
          attachments.push({ name, mimeType, origin:'inbound' });
        }
      }
      const text = (m.parts||[]).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n');
      if (m.role === 'agent') {
        append({ type:'remote_received', messageId:m.messageId, text, attachments: attachments.length?attachments:undefined }, 'public');
      } else {
        append({ type:'remote_sent', messageId:m.messageId, text, attachments: attachments.length?attachments:undefined }, 'public');
      }
    }
  }

  return {
    endpoint: '',
    role: 'initiator',
    taskId: undefined,
    pairId: undefined,
    status: 'waiting-for-task',
    journal: { seq: 0, facts: [] },
    ticksRunning: false,
    sending: false,

    configure(endpoint: string, role: Role) {
      set({ endpoint, role });
      client = new A2AClient(endpoint);
      try {
        // Derive pairId from endpoint /api/bridge/:pairId/a2a
        const u = new URL(endpoint);
        const parts = u.pathname.split('/').filter(Boolean);
        const ix = parts.findIndex(p => p === 'bridge');
        if (ix !== -1 && parts.length > ix + 1) set({ pairId: parts[ix + 1] });
      } catch {}
      const pairId = get().pairId;
      set({ transport: new A2ATransport(client, { role, pairId }) });
      // If a taskId already exists (e.g., persisted or restored), immediately resubscribe
      const existingTaskId = get().taskId;
      if (existingTaskId) {
        try {
          get().startTicks(existingTaskId);
        } catch {}
      }
    },

    ingestFrame(frame: FrameResult) {
      if (!frame) return;
      if ('kind' in frame) {
        if (frame.kind === 'task') {
          set({ taskId: frame.id });
          ingestTaskSnapshot(frame);
        } else if (frame.kind === 'status-update') {
          set({ status: frame.status?.state || 'submitted' });
          if (frame.status?.message) ingestTaskSnapshot({ id: frame.taskId, contextId: frame.contextId, status: frame.status, kind:'task', history: [] });
        } else if (frame.kind === 'message') {
          ingestTaskSnapshot({ id: frame.messageId || rid('m'), contextId: '', kind:'task', status: { state: 'submitted', message: { role: frame.role, parts: frame.parts, messageId: frame.messageId || rid('m'), kind:'message' } }, history: [] } as any);
        }
      }
    },

    async sendManual(text, finality) {
      const parts: A2APart[] = [{ kind:'text', text, metadata: { 'https://chitchat.fhir.me/a2a-ext': { finality } } }];
      set({ sending: true });
      try {
        const taskId = get().taskId;
        const t = get().transport;
        if (!t) throw new Error('transport not configured');
        const out = await t.send(parts, { taskId, finality });
        set({ taskId: out.taskId });
        ingestTaskSnapshot(out.snapshot as any);
        // Ensure ticks are running
        get().startTicks(out.taskId);
      } finally {
        set({ sending: false });
      }
    },

    async cancelTask() {
      const id = get().taskId;
      if (!id) return;
      try {
        const t = get().transport;
        if (t) await t.cancel(id);
        // After server confirms, clear local state and stop reads
        set({ taskId: undefined, status: 'waiting-for-task', journal: { seq: 0, facts: [] } });
        get().stopTicks();
      } catch (e) {
        console.error('[store] cancel failed', e);
      }
    },

    startTicks(taskId?: string) {
      const id = taskId || get().taskId;
      if (!id) return;
      // idempotent start for the same task
      if (ticker && ticker.taskId === id && !ticker.stopped) return;
      // stop previous if switching tasks
      if (ticker) { try { ticker.stopped = true; ticker.ac.abort(); } catch {} ticker = null; }
      const ac = new AbortController();
      ticker = { taskId: id, ac, stopped: false };
      set({ ticksRunning: true });
      (async () => {
        const t = get().transport;
        if (!t) return;
        // Fetch an initial snapshot immediately to sync status/UI without waiting for first tick
        try { const snap = await t.snapshot(id); if (snap) ingestTaskSnapshot(snap as any); } catch {}
        for await (const _ of t.ticks(id, ac.signal)) {
          try { const snap = await t.snapshot(id); if (snap) ingestTaskSnapshot(snap as any); } catch {}
        }
      })().catch(err => console.error('[store] tick loop failed', err));
    },

    stopTicks() {
      set({ ticksRunning: false });
      try { ticksAborter?.abort(); } catch {}
      ticksAborter = null;
      if (ticker) { try { ticker.stopped = true; ticker.ac.abort(); } catch {}; ticker = null; }
    },

    // Responder: watch pair control events and adopt announced taskId
    bootResponder(pairId: string) {
      if (bc && bc.pairId === pairId) return;
      // restart watcher
      if (bc) { try { bc.ac.abort(); } catch {} bc = null; }
      const ac = new AbortController();
      bc = { pairId, ac };
      (async () => {
        const c = ensureClient();
        for await (const ev of c.pairEvents(pairId, pairCursor ?? 0, ac.signal)) {
          if (ev && typeof ev.seq === 'number') pairCursor = ev.seq;
          if (ev?.type === 'backchannel' && ev?.action === 'subscribe' && typeof ev.taskId === 'string') {
            if (String(ev.taskId || '').startsWith('resp:')) {
              if (get().taskId !== ev.taskId) {
                set({ taskId: ev.taskId });
                get().startTicks(ev.taskId);
                // Eagerly pull snapshot so status isn't left as 'waiting-for-task'
                try { await fetchSnapshot(ev.taskId); } catch {}
              }
            }
          }
        }
      })().catch(err => console.error('[store] backchannel loop failed', err));
    },

    stopBackchannel() {
      if (bc) { try { bc.ac.abort(); } catch {}; bc = null; }
    }
  };
});
