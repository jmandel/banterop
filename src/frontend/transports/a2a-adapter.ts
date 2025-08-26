import type { TransportAdapter, TransportSnapshot, SendOptions } from "./types";
import type { A2APart, A2ATask } from "../../shared/a2a-types";
import { A2AClient } from "./a2a-client";
import { A2A_EXT_URL } from "../../shared/core";

function toSnap(t: A2ATask | null): TransportSnapshot | null {
  if (!t) return null;
  return { kind: 'task', id: t.id, status: t.status, history: Array.isArray(t.history) ? t.history : [] };
}

// Planner-compatible name
export class A2AAdapter implements TransportAdapter {
  private client: A2AClient;
  constructor(endpoint: string) { this.client = new A2AClient(endpoint); }
  kind(): 'a2a' { return 'a2a'; }
  async send(parts: A2APart[], opts: SendOptions): Promise<{ taskId: string; snapshot: TransportSnapshot }> {
    const metadata = opts.finality ? { [A2A_EXT_URL]: { finality: opts.finality } } as any : undefined;
    const snap = await this.client.messageSend(parts, { taskId: opts.taskId, messageId: opts.messageId, metadata });
    return { taskId: snap.id, snapshot: toSnap(snap)! };
  }
  async snapshot(taskId: string): Promise<TransportSnapshot | null> {
    const t = await this.client.tasksGet(taskId);
    return toSnap(t);
  }
  async cancel(taskId: string): Promise<void> { await this.client.cancel(taskId); }
  async *ticks(taskId: string, signal?: AbortSignal): AsyncGenerator<void> { for await (const _ of this.client.ticks(taskId, signal)) yield; }
}

// Backwards-compat export if any code imports A2ATransport
export { A2AAdapter as A2ATransport };
