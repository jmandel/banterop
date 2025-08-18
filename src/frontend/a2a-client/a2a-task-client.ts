import type { A2AFrame, A2AMessage, A2APart, A2AStatus, A2ATask } from "./a2a-types";
import { A2AClient } from "./a2a-client";

export type A2AEventType = "new-task" | "error";

const DEFAULT_DEBOUNCE_INTERVAL = 100; // ms

export class A2ATaskClient {
  private listeners = new Map<A2AEventType, Set<(ev: any) => void>>();
  private a2a: A2AClient;

  private taskId?: string;
  private currentTask: A2ATask | null = null;
  private status: A2AStatus | "initializing" = "initializing";

  private canonicalState?: {
    status: A2AStatus;
    messageIds: Set<string>;
    knownMessages: Map<string, A2AMessage>;
  };

  private streamAbort: AbortController | null = null;
  private resubAbort: AbortController | null = null;

  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly debounceInterval: number;

  constructor(endpointUrl: string, debounceInterval = DEFAULT_DEBOUNCE_INTERVAL) {
    this.a2a = new A2AClient(endpointUrl);
    this.debounceInterval = debounceInterval;
  }

  // Clear local state and abort any active streams/resubscriptions.
  // Does not call the server; caller should cancel remotely if desired.
  clearLocal() {
    try { this.streamAbort?.abort(); } catch {}
    try { this.resubAbort?.abort(); } catch {}
    this.streamAbort = null;
    this.resubAbort = null;
    this.taskId = undefined;
    this.currentTask = null;
    this.status = 'initializing';
    this.canonicalState = undefined;
  }

  on<T = any>(eventType: A2AEventType, cb: (ev: T) => void): () => void {
    if (!this.listeners.has(eventType)) this.listeners.set(eventType, new Set());
    const set = this.listeners.get(eventType)!;
    set.add(cb as any);
    return () => set.delete(cb as any);
  }

  private emit(type: A2AEventType, data: any) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const cb of set) {
      try { (cb as any)(data); } catch (e) { console.error("[A2ATaskClient] listener error", e); }
    }
  }

  getTask(): A2ATask | null { return this.currentTask; }
  getTaskId(): string | undefined { return this.taskId; }
  getStatus(): A2AStatus | "initializing" { return this.status; }

  async resume(taskId: string) {
    this.taskId = taskId;
    await this.refetchAndProcess();
    this.openResubscribe();
  }

  async startNew(parts: A2APart[]) {
    console.log('[TaskClient] startNew: begin', { parts: Array.isArray(parts) ? parts.length : 0, taskId: this.taskId });
    try { this.streamAbort?.abort(); } catch {}
    try { this.resubAbort?.abort(); } catch {}
    const ac = new AbortController();
    this.streamAbort = ac;

    try {
      for await (const frame of this.a2a.messageStreamParts(parts, undefined, ac.signal)) {
        this.processFrame(frame);
      }
    } catch (e: any) {
      const err = String(e?.message ?? e);
      console.warn('[TaskClient] startNew error:', err);
      this.emit("error", { error: err });
    } finally {
      if (this.streamAbort === ac) this.streamAbort = null;
      console.log('[TaskClient] startNew: stream ended; status=', this.status, 'taskId=', this.taskId);
      this.openResubscribeIfActive();
    }
  }

  async send(parts: A2APart[]) {
    console.log('[TaskClient] send: begin', { parts: Array.isArray(parts) ? parts.length : 0, taskId: this.taskId });
    if (!this.taskId) return this.startNew(parts);
    try { this.streamAbort?.abort(); } catch {}
    const ac = new AbortController();
    this.streamAbort = ac;

    try {
      for await (const frame of this.a2a.messageStreamParts(parts, this.taskId, ac.signal)) {
        this.processFrame(frame);
      }
    } catch (e: any) {
      const err = String(e?.message ?? e);
      console.warn('[TaskClient] send error:', err);
      this.emit("error", { error: err });
    } finally {
      if (this.streamAbort === ac) this.streamAbort = null;
      console.log('[TaskClient] send: stream ended; status=', this.status, 'taskId=', this.taskId);
      this.openResubscribeIfActive();
    }
  }

  // Debounced trigger from SSE
  private processFrame(frame: A2AFrame) {
    const r: any = (frame as any).result;
    if (r?.taskId && !this.taskId) this.taskId = r.taskId;
    if (r?.id && !this.taskId && r.kind === "task") this.taskId = r.id;
    try { console.debug('[TaskClient] processFrame:', r?.kind, 'taskId=', this.taskId); } catch {}

    // debounce refetch
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.refetchAndProcess();
    }, this.debounceInterval);
  }

  private async refetchAndProcess() {
    if (!this.taskId) return;
    try {
      const snap = await this.a2a.tasksGet(this.taskId, "full");
      this.applyCanonicalDiff(snap);
    } catch (e: any) {
      const err = String(e?.message ?? e);
      console.warn('[TaskClient] refetch error:', err);
      this.emit("error", { error: err });
    }
  }

  private openResubscribeIfActive() {
    if (
      this.status !== "completed" &&
      this.status !== "failed" &&
      this.status !== "input-required" &&
      (this as any).status !== "canceled"
    ) {
      this.openResubscribe();
    }
  }

  private openResubscribe() {
    if (!this.taskId) return;
    if (this.resubAbort) {
      try { this.resubAbort.abort(); } catch {}
    }
    const ac = new AbortController();
    this.resubAbort = ac;
    (async () => {
      try {
        for await (const frame of this.a2a.tasksResubscribe(this.taskId!, ac.signal)) {
          this.processFrame(frame);
        }
      } catch (e: any) {
        this.emit("error", { error: String(e?.message ?? e) });
      }
    })();
  }

  // Canonicalization + Diff
  private applyCanonicalDiff(newTask: A2ATask) {
    const incomingHistory = newTask.history ?? [];
    const incomingIds = new Set(incomingHistory.map(m => m.messageId));
    const newStatus = (newTask.status?.state ?? this.status) as A2AStatus;

    const prev = this.canonicalState;
    const statusChanged = !prev || prev.status !== newStatus;
    const anyNewIds = !prev || [...incomingIds].some(id => !prev.messageIds.has(id));
    if (!statusChanged && !anyNewIds) return;

    const missingFromIncoming: A2AMessage[] = [];
    if (prev?.knownMessages) {
      for (const [id, msg] of prev.knownMessages) {
        if (!incomingIds.has(id)) missingFromIncoming.push(msg);
      }
    }
    const repairedHistory = [...missingFromIncoming, ...incomingHistory];

    const knownMessages = new Map(prev?.knownMessages ?? []);
    for (const m of repairedHistory) knownMessages.set(m.messageId, m);

    const canonicalIds = new Set(repairedHistory.map(m => m.messageId));
    const snapshot: A2ATask = {
      ...newTask,
      history: repairedHistory,
      status: { ...(newTask.status ?? {}), state: newStatus } as any,
    };

    this.canonicalState = { status: newStatus, messageIds: canonicalIds, knownMessages };
    this.currentTask = snapshot;
    this.taskId = snapshot.id ?? this.taskId;
    this.status = newStatus;
    try { console.debug('[TaskClient] emit new-task:', { status: newStatus, messages: repairedHistory.length }); } catch {}
    this.emit("new-task", this.currentTask);
  }
}
