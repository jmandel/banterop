import type { TransportAdapter, TransportSnapshot, SendOptions } from "./types";
import type { A2APart, A2ATask } from "../../shared/a2a-types";
import { A2AClient } from "./a2a-client";
import { A2A_EXT_URL } from "../../shared/core";

function toSnap(t: A2ATask | null): TransportSnapshot | null {
  if (!t) return null;
  return { kind: 'task', id: t.id, status: t.status, history: Array.isArray(t.history) ? t.history : [] };
}

// Planner-compatible name
type WireEntry = { protocol:'a2a'|'mcp'; dir:'inbound'|'outbound'; method?:string; kind?:string; roomId?:string; taskId?:string; messageId?:string; payload:any };

export class A2AAdapter implements TransportAdapter {
  private client: A2AClient;
  private leaseId: string | null = null;
  private onWire?: (e: WireEntry) => void;
  private roomId?: string;
  private seenByTask: Map<string, Set<string>> = new Map();
  private suppressOwnFromSnapshots: boolean = false;
  constructor(endpoint: string, opts?: { onWire?: (e: WireEntry)=>void; roomId?: string; suppressOwnFromSnapshots?: boolean }) {
    this.client = new A2AClient(endpoint, () => {
      return this.leaseId ? { 'X-Banterop-Backend-Lease': this.leaseId } : undefined;
    });
    this.onWire = opts?.onWire;
    this.roomId = opts?.roomId;
    this.suppressOwnFromSnapshots = !!opts?.suppressOwnFromSnapshots;
  }
  setBackendLease(leaseId: string | null) { this.leaseId = leaseId; }
  kind(): 'a2a' { return 'a2a'; }
  async send(parts: A2APart[], opts: SendOptions): Promise<{ taskId: string; snapshot: TransportSnapshot }> {
    const metadata = opts.nextState ? { [A2A_EXT_URL]: { nextState: opts.nextState } } as any : undefined;
    try {
      const msg = { role:'user', parts, messageId: opts.messageId || '', kind:'message' };
      this.onWire && this.onWire({ protocol:'a2a', dir:'outbound', method:'message/send', kind:'message', roomId:this.roomId, taskId:opts.taskId, messageId:opts.messageId, payload: msg });
    } catch {}
    const snap = await this.client.messageSend(parts, { taskId: opts.taskId, messageId: opts.messageId, metadata });
    return { taskId: snap.id, snapshot: toSnap(snap)! };
  }
  async snapshot(taskId: string): Promise<TransportSnapshot | null> {
    const t = await this.client.tasksGet(taskId);
    // Log inbound wire messages from snapshot exactly once per messageId
    try {
      if (t) {
        const seen = this.seenByTask.get(t.id) || new Set<string>();
        const maybeLog = (m:any) => {
          if (!m || typeof m !== 'object') return;
          const mid = String((m as any).messageId || '');
          if (!mid || seen.has(mid)) return;
          // No raw stamp handling; log projected messages only
          // Optionally skip our own projected messages from snapshots (client context)
          if (this.suppressOwnFromSnapshots && (m as any).role === 'user') return;
          seen.add(mid);
          this.onWire && this.onWire({ protocol:'a2a', dir:'inbound', method:'message/send', kind:'message', roomId:this.roomId, taskId:t.id, messageId:mid, payload:m });
        };
        for (const m of (Array.isArray(t.history) ? t.history : [])) maybeLog(m);
        if (t.status && (t.status as any).message) maybeLog((t.status as any).message);
        this.seenByTask.set(t.id, seen);
      }
    } catch {}
    return toSnap(t);
  }
  async cancel(taskId: string): Promise<void> { await this.client.cancel(taskId); }
  async *ticks(taskId: string, signal?: AbortSignal): AsyncGenerator<void> { for await (const _ of this.client.ticks(taskId, signal)) yield; }
}

// Backwards-compat export if any code imports A2ATransport
export { A2AAdapter as A2ATransport };
