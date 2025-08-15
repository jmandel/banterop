import type { A2AFrame, A2AMessage, A2AStatus, A2ATask } from "./a2a-types";
import { partsToText, sleep } from "./a2a-utils";
import { A2AClient } from "./a2a-client";

export type AgentLogEntry = {
  id: string;
  role: "planner" | "agent";
  text: string;
  partial?: boolean;
  attachments?: Array<{ name: string; mimeType: string; bytes?: string; uri?: string }>;
};

export class TaskHistoryStore {
  private client: A2AClient | null;
  private listeners = new Set<() => void>();

  private taskId?: string;
  private status: A2AStatus = "submitted";
  private history: A2AMessage[] = [];
  private seen = new Set<string>();
  private partials = new Map<string, { text: string; role: "user" | "agent" }>();
  private optimistics: (AgentLogEntry & { __order: number })[] = [];
  private resubAbort: AbortController | null = null;
  private orderCounter = 0;
  private msgOrder = new Map<string, number>();
  private partialOrder = new Map<string, number>();
  private msgContentById = new Map<string, string>();
  private dupCounterByBase = new Map<string, number>();

  constructor(client?: A2AClient | null) { this.client = client ?? null; }
  setClient(c: A2AClient | null) { this.client = c; }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const fn of this.listeners) fn(); }

  getTaskId(): string | undefined { return this.taskId; }
  hasTask(): boolean { return !!this.taskId; }
  getStatus(): A2AStatus { return this.status; }

  clear() {
    this.taskId = undefined;
    this.status = "submitted";
    this.history = [];
    this.seen.clear();
    this.partials.clear();
    this.optimistics = [];
    if (this.resubAbort) {
      try { console.warn(`[SSEAbort] Store: aborting resubscribe due to clear() (taskId=${this.taskId || 'n/a'})`); } catch {}
      try { this.resubAbort.abort(); } catch {}
    }
    this.resubAbort = null;
    this.msgContentById.clear();
    this.dupCounterByBase.clear();
    this.emit();
  }

  getPlannerFullHistory(): Array<{ role: "user" | "agent"; text: string }> {
    const arr: Array<{ role: "user" | "agent"; text: string }> = [];
    for (const m of this.history) {
      const text = partsToText(m.parts);
      if (!text) continue;
      arr.push({ role: m.role, text });
    }
    return arr;
  }

  getAgentLogEntries(): AgentLogEntry[] {
    const entries: { entry: AgentLogEntry; order: number }[] = [];
    for (const m of this.history) {
      const text = partsToText(m.parts);
      const atts = (m.parts || [])
        .filter((p: any) => p?.kind === "file" && p?.file)
        .map((p: any) => ({ name: String(p.file.name || "attachment"), mimeType: String(p.file.mimeType || "application/octet-stream"), bytes: p.file.bytes, uri: p.file.uri })) as Array<{ name: string; mimeType: string; bytes?: string; uri?: string }>;
      if (!text && !atts.length) continue;
      const order = this.msgOrder.get(m.messageId) ?? (++this.orderCounter);
      this.msgOrder.set(m.messageId, order);
      entries.push({ entry: { id: m.messageId, role: m.role === "user" ? "planner" : "agent", text: text || "", ...(atts.length ? { attachments: atts } : {}) }, order });
    }
    for (const [mid, p] of this.partials) {
      const order = this.partialOrder.get(mid) ?? (++this.orderCounter);
      this.partialOrder.set(mid, order);
      entries.push({ entry: { id: `${mid}:partial`, role: p.role === "user" ? "planner" : "agent", text: p.text, partial: true }, order });
    }
    for (const o of this.optimistics) entries.push({ entry: { id: o.id, role: o.role, text: o.text, partial: o.partial, attachments: o.attachments }, order: o.__order });
    return entries.sort((a, b) => a.order - b.order).map(e => e.entry);
  }

  addOptimisticUserMessage(text: string) {
    if (!text.trim()) return;
    this.optimistics.push({ id: `local:${crypto.randomUUID()}`, role: "planner", text, __order: ++this.orderCounter });
    this.emit();
  }
  private popOneOptimistic() { if (this.optimistics.length) this.optimistics.shift(); }

  async resume(taskId: string) {
    if (!this.client) throw new Error("No A2A client");
    this.taskId = taskId;
    const t = await this.client.tasksGet(taskId, "full");
    this.ingestTaskSnapshot(t);
    this.openResubscribe(taskId);
  }
  private openResubscribe(taskId: string) {
    if (!this.client) return;
    if (this.resubAbort) {
      try { console.warn(`[SSEAbort] Store: aborting existing resubscribe stream (taskId=${this.taskId || taskId})`); } catch {}
      try { this.resubAbort.abort(); } catch {}
    }
    const ac = new AbortController();
    this.resubAbort = ac;
    try { console.debug(`[Store] openResubscribe(${taskId})`); } catch {}
    (async () => {
      let attempt = 0;
      while (!ac.signal.aborted) {
        if (this.status === "completed" || this.status === "failed" || this.status === "canceled") {
          try { console.debug(`[Store] resubscribe halted due to status=${this.status}`); } catch {}
          break;
        }
        try {
          // Start resubscribe consumer first to avoid missing frames
          const consume = (async () => {
            for await (const frame of this.client!.tasksResubscribe(taskId, ac.signal)) {
              this.ingestFrame(frame);
              attempt = 0; // reset backoff on any data
            }
          })();

          // After subscription is underway, fetch a full snapshot in the background
          (async () => {
            try {
              // Small delay to let the subscription establish
              await sleep(10);
              const snap = await this.client!.tasksGet(taskId, "full");
              this.ingestFrame({ result: snap } as any);
            } catch {}
          })();

          await consume; // wait until the stream ends before retrying
        } catch (e) {
          try { console.debug(`[Store] resubscribe error; will retry`, e); } catch {}
        }
        if (ac.signal.aborted) break;
        attempt++;
        const delay = Math.min(5000, 250 * Math.pow(2, Math.min(5, attempt - 1)));
        try { console.debug(`[Store] resubscribe retry #${attempt} in ${delay}ms`); } catch {}
        await sleep(delay);
      }
    })();
  }

  // Public helper: ensure we are resubscribed to updates for the current task
  resubscribe() {
    if (!this.client || !this.taskId) return;
    this.openResubscribe(this.taskId);
  }

  ingestFrame(frame: A2AFrame) {
    const r: any = (frame as any).result;
    if (!r) return;
    let changed = false;
    if (r.kind === "task") {
      const t = r as A2ATask;
      // Record task id, but do not auto-resubscribe here.
      // In the no-handoff flow, the original message/stream remains open.
      if (!this.taskId) { this.taskId = t.id; }
      try { console.debug(`[Store] task snapshot arrived id=${t.id} status=${t.status?.state}`); } catch {}
      changed = this.ingestTaskSnapshot(t);
      if (changed) this.emit();
      return;
    }

    if (r.kind === "message" && (r as any).messageId) {
      const m = r as A2AMessage;
      try { console.debug(`[Store] message arrived midstream id=${m.messageId} role=${m.role}`); } catch {}
      changed = this.ingestMessage(m);
      if (changed) this.emit();
      return;
    }

    if (r.kind === "status-update") {
      const su = r as any;
      const st = su.status?.state as A2AStatus;
      try { console.debug(`[Store] status-update arrived state=${st}`); } catch {}
      const priorStatus = this.status;
      this.status = st || this.status;
      changed = changed || (this.status !== priorStatus);
      const m = su.status?.message as A2AMessage | undefined;
      if (m) {
        const text = partsToText(m.parts);
        if (text) {
          if (st === "working") {
            this.partials.set(m.messageId, { text, role: m.role });
            try { console.debug(`[Store] partial update id=${m.messageId} role=${m.role}`); } catch {}
            changed = true;
          } else {
            this.partials.delete(m.messageId);
            changed = this.ingestMessage(m) || changed;
          }
        }
      }
      if (changed) this.emit();
      return;
    }
  }

  private ingestTaskSnapshot(t: A2ATask): boolean {
    let changed = false;
    this.taskId = t.id;
    const priorStatus = this.status;
    this.status = (t.status?.state ?? "submitted");
    if (this.status !== priorStatus) changed = true;
    if (Array.isArray(t.history)) {
      for (const h of t.history) {
        const added = this.ingestMessage(h);
        if (added) changed = true;
      }
    }
    const sm = t.status?.message;
    if (sm) {
      const text = partsToText(sm.parts);
      if (text) {
        if (t.status.state === "working") { this.partials.set(sm.messageId, { text, role: sm.role }); changed = true; }
        else { this.partials.delete(sm.messageId); const added = this.ingestMessage(sm); if (added) changed = true; }
      }
    }
    return changed;
  }

  private ingestMessage(m: A2AMessage): boolean {
    const text = partsToText(m.parts);
    const attSig = (m.parts || [])
      .filter((p: any) => p?.kind === 'file' && p?.file)
      .map((p: any) => `${p.file.name}:${p.file.mimeType}`)
      .join('|');
    const contentKey = `${m.role}|${text}|${attSig}`;

    if (this.seen.has(m.messageId)) {
      // If a duplicate id carries different content, synthesize a unique id and accept it
      const prior = this.msgContentById.get(m.messageId);
      if (prior === contentKey) return false; // true duplicate; ignore
      const base = m.messageId;
      const next = (this.dupCounterByBase.get(base) || 0) + 1;
      this.dupCounterByBase.set(base, next);
      const newId = `${base}:${next}`;
      m = { ...m, messageId: newId };
    }

    if (m.role === "user") this.popOneOptimistic();
    this.seen.add(m.messageId);
    this.msgContentById.set(m.messageId, contentKey);
    const order = ++this.orderCounter;
    this.msgOrder.set(m.messageId, order);
    this.history.push(m);
    try { console.debug(`[Store] ingest message id=${m.messageId} role=${m.role} order=${order}`); } catch {}
    return true;
  }
}
