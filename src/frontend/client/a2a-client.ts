import type { A2AFrame, A2APart, A2ATask } from "./a2a-types";
import { readSSE } from "./a2a-utils";

export class A2AClient {
  constructor(private endpointUrl: string) {}
  private endpoint() { return this.endpointUrl; }

  async messageSendParts(parts: A2APart[], taskId?: string): Promise<A2ATask> {
    const body = { jsonrpc: "2.0", id: crypto.randomUUID(), method: "message/send", params: { message: { messageId: crypto.randomUUID(), ...(taskId ? { taskId } : {}), parts } } };
    const res = await fetch(this.endpoint(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`message/send failed: ${res.status} ${await res.text()}`);
    const j = (await res.json()) as { result?: A2ATask; error?: { message: string } };
    if (!j.result) throw new Error(j.error?.message || "no result");
    return j.result;
  }

  async *messageStreamParts(parts: A2APart[], taskId?: string, signal?: AbortSignal): AsyncGenerator<A2AFrame> {
    const body = { jsonrpc: "2.0", id: crypto.randomUUID(), method: "message/stream", params: { message: { messageId: crypto.randomUUID(), ...(taskId ? { taskId } : {}), parts } } };
    const res = await fetch(this.endpoint(), { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`message/stream failed: ${res.status} ${await res.text()}`);
    for await (const data of readSSE(res)) {
      try { console.debug(`[A2AClient] SSE event (message/stream) bytes=${data?.length ?? 0}`); } catch {}
      try { const obj = JSON.parse(data) as A2AFrame; if (obj && "result" in obj) yield obj; } catch {}
    }
  }

  async *tasksResubscribe(taskId: string, signal?: AbortSignal): AsyncGenerator<A2AFrame> {
    const body = { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tasks/resubscribe", params: { id: taskId } };
    const res = await fetch(this.endpoint(), { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`resubscribe failed: ${res.status} ${await res.text()}`);
    for await (const data of readSSE(res)) {
      try { console.debug(`[A2AClient] SSE event (resubscribe) bytes=${data?.length ?? 0}`); } catch {}
      try { const obj = JSON.parse(data) as A2AFrame; if (obj && "result" in obj) yield obj; } catch {}
    }
  }

  async tasksCancel(taskId: string) {
    const body = { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tasks/cancel", params: { id: taskId } };
    const res = await fetch(this.endpoint(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`cancel failed: ${res.status} ${await res.text()}`);
    const j = (await res.json()) as { result?: A2ATask; error?: { message: string } };
    if (!j.result) throw new Error(j.error?.message || "no result");
    return j.result;
  }

  async tasksGet(taskId: string, include: "full" | "history" | "status" = "full", signal?: AbortSignal) {
    const body = { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tasks/get", params: { id: taskId, include } };
    const res = await fetch(this.endpoint(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`tasks/get failed: ${res.status} ${await res.text()}`);
    const j = (await res.json()) as { result?: A2ATask; error?: { message: string } };
    if (!j.result) throw new Error(j.error?.message || "no result");
    return j.result;
  }
}
