import type { A2APart, A2ATask, A2AStatusUpdate } from "../../shared/a2a-types";

export type FrameResult =
  | A2ATask
  | A2AStatusUpdate
  | { kind:'message'; role:'user'|'agent'; parts:A2APart[]; messageId?: string };

export class A2AClient {
  constructor(private endpoint: string) {}
  private ep() { return this.endpoint }

  async *messageStreamParts(parts: A2APart[], opts:{ taskId?:string; messageId?:string; signal?:AbortSignal }={}) {
    const body = { jsonrpc: '2.0', id: crypto.randomUUID(), method: 'message/stream', params: { message: { messageId: opts.messageId || crypto.randomUUID(), ...(opts.taskId ? { taskId: opts.taskId } : {}), parts } } };
    const res = await fetch(this.ep(), { method: 'POST', headers: { 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify(body), signal: opts.signal });
    if (!res.ok || !res.body) throw new Error('message/stream failed: ' + res.status);
    for await (const obj of sseToObjects(res.body)) yield obj;
  }
  async *tasksResubscribe(taskId: string, signal?: AbortSignal) {
    const body = { jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tasks/resubscribe', params: { id: taskId } };
    const res = await fetch(this.ep(), { method: 'POST', headers: { 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) throw new Error('resubscribe failed: ' + res.status);
    for await (const obj of sseToObjects(res.body)) yield obj;
  }
  // Resilient forever-loop of resubscribe ticks with backoff
  async *ticks(taskId: string, signal?: AbortSignal): AsyncGenerator<void> {
    let attempt = 0;
    while (!signal?.aborted) {
      try {
        for await (const _ of this.tasksResubscribe(taskId, signal)) {
          attempt = 0; // got data -> reset backoff
          yield;
        }
        // normal end (server closed): fall through to backoff+retry
      } catch (err) {
        if (signal?.aborted) break;
        console.warn('[ticks] stream error', err);
      }
      const ms = Math.min(10000, 500 * 2 ** Math.min(attempt++, 5));
      await sleep(ms, signal);
    }
  }

  // One pair-wide SSE control plane (epoch-begin, backchannel, state, message, ...)
  async *pairEvents(pairId: string, since?: number, signal?: AbortSignal): AsyncGenerator<any> {
    let cursor = since ?? 0;
    let attempt = 0;
    const base = new URL(this.ep());
    const urlBase = `${base.origin}/pairs/${encodeURIComponent(pairId)}/events.log`;
    while (!signal?.aborted) {
      const url = `${urlBase}?since=${encodeURIComponent(String(cursor))}`;
      try {
        const res = await fetch(url, { method: 'GET', headers: { 'accept':'text/event-stream' }, signal });
        if (!res.ok || !res.body) throw new Error('events.log failed: ' + res.status);
        for await (const ev of sseToAny(res.body)) {
          attempt = 0;
          if (ev && typeof ev === 'object' && 'seq' in ev && Number.isFinite((ev as any).seq)) {
            const seq = Number((ev as any).seq);
            if (Number.isFinite(seq)) cursor = Math.max(cursor, seq);
          }
          yield ev;
        }
      } catch (e) {
        if (signal?.aborted) break;
        console.warn('[pairEvents] stream error', e);
      }
      const ms = Math.min(10000, 500 * 2 ** Math.min(attempt++, 5));
      await sleep(ms, signal);
    }
  }
  async tasksGet(taskId: string): Promise<A2ATask | null> {
    const body = { jsonrpc:'2.0', id: crypto.randomUUID(), method: 'tasks/get', params: { id: taskId } };
    const res = await fetch(this.ep(), { method:'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(body) });
    const j = await res.json();
    return j.result || null;
  }
  async cancel(taskId: string) {
    const body = { jsonrpc:'2.0', id: crypto.randomUUID(), method: 'tasks/cancel', params: { id: taskId } };
    await fetch(this.ep(), { method:'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(body) });
  }
  async messageSend(parts: A2APart[], opts:{ taskId?:string; messageId?:string }): Promise<A2ATask> {
    const body = { jsonrpc:'2.0', id: crypto.randomUUID(), method: 'message/send', params: { message: { taskId: opts.taskId, messageId: opts.messageId || crypto.randomUUID(), parts } } };
    const res = await fetch(this.ep(), { method:'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('message/send failed: ' + res.status);
    const j = await res.json();
    return j.result as A2ATask;
  }
}

async function* sseToObjects(stream: ReadableStream<Uint8Array>): AsyncGenerator<FrameResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const i = buf.indexOf('\n\n');
      const j = buf.indexOf('\r\n\r\n');
      const idx = i !== -1 ? i : (j !== -1 ? j : -1);
      const dlen = i !== -1 ? 2 : (j !== -1 ? 4 : 0);
      if (idx === -1) break;
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + dlen);
      const lines = chunk.replace(/\r/g, '').split('\n');
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trimStart();
          try { const obj = JSON.parse(data); if (obj && 'result' in obj) yield (obj.result as FrameResult); } catch {}
        }
      }
    }
  }
}

async function* sseToAny(stream: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const i = buf.indexOf('\n\n');
      const j = buf.indexOf('\r\n\r\n');
      const idx = i !== -1 ? i : (j !== -1 ? j : -1);
      const dlen = i !== -1 ? 2 : (j !== -1 ? 4 : 0);
      if (idx === -1) break;
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + dlen);
      const lines = chunk.replace(/\r/g, '').split('\n');
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trimStart();
          try { const obj = JSON.parse(data); if (obj && 'result' in obj) yield (obj.result as any); } catch {}
        }
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { try { clearTimeout(t); } catch {}; rej(signal.reason); }, { once: true });
  });
}

