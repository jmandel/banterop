import type { TransportAdapter, TransportSnapshot } from "./types";
import type { A2APart, A2ATask, A2AStatusUpdate } from "../../shared/a2a-types";
import { A2AClient } from "../transport/a2a-client";

export class A2AAdapter implements TransportAdapter {
  private client: A2AClient;
  constructor(private endpoint: string) {
    this.client = new A2AClient(endpoint);
  }
  kind(): 'a2a'|'mcp' { return 'a2a'; }

  async *ticks(taskId: string, signal?: AbortSignal): AsyncGenerator<void> {
    for await (const _ of this.client.tasksResubscribe(taskId, signal)) {
      yield;
    }
  }

  async snapshot(taskId: string): Promise<TransportSnapshot | null> {
    const snap = await this.client.tasksGet(taskId);
    if (!snap) return null;
    return normalizeTask(snap);
  }

  async send(parts: A2APart[], opts: { taskId?: string; messageId?: string; finality?: 'none'|'turn'|'conversation' }): Promise<{ taskId: string; snapshot: TransportSnapshot }> {
    const task = await this.client.messageSend(parts, { taskId: opts.taskId, messageId: opts.messageId });
    return { taskId: task.id, snapshot: normalizeTask(task) };
  }

  async cancel(taskId: string): Promise<void> {
    await this.client.cancel(taskId);
  }
}

function normalizeTask(t: A2ATask): TransportSnapshot {
  const history = Array.isArray(t.history) ? t.history.slice() : [];
  return {
    kind: 'task',
    id: t.id,
    status: t.status,
    history
  };
}
