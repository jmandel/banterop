import type { A2APart, A2ATask, A2AStatusUpdate } from "../../shared/a2a-types";
import { parseSse } from "../../shared/sse";

export type FrameResult =
  | A2ATask
  | A2AStatusUpdate
  | { kind:'message'; role:'user'|'agent'; parts:A2APart[]; messageId?: string };

export class A2AClient {
  constructor(private endpoint: string, private getHeaders?: () => Record<string,string> | undefined) {}
  private ep() { return this.endpoint }

  // Helpers for clarity
  private makeHeaders(acceptSse: boolean): Record<string,string> {
    const base: Record<string,string> = { 'content-type':'application/json' };
    if (acceptSse) base['accept'] = 'text/event-stream';
    const extra = this.getHeaders ? (this.getHeaders() || {}) : {};
    return { ...base, ...extra };
  }
  private safeCancel(stream?: ReadableStream | null) {
    try {
      const s: any = stream as any;
      if (!s) return;
      if (typeof s.locked === 'boolean' && s.locked) return;
      const p = s.cancel?.();
      if (p && typeof p.then === 'function') { p.catch?.(() => {}); }
    } catch {}
  }
  private isJson(ct: string) { return (ct || '').includes('application/json'); }
  private isSse(ct: string) { return (ct || '').includes('text/event-stream'); }
  private isTerminal(state?: string) {
    const v = String(state || '').toLowerCase();
    return v === 'completed' || v === 'canceled' || v === 'failed' || v === 'rejected';
  }
  private async *trySse(method: 'tasks/resubscribe'|'tasks/subscribe', taskId: string, signal?: AbortSignal): AsyncGenerator<FrameResult> {
    console.log(`[A2AClient] SSE try ${method} id=${taskId}`);
    const body = { jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { id: taskId } };
    const res = await fetch(this.ep(), { method: 'POST', headers: this.makeHeaders(true), body: JSON.stringify(body), signal });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) { console.warn(`[A2AClient] SSE ${method} HTTP ${res.status} ${res.statusText || ''} → fallback`); this.safeCancel(res.body); return; }
    if (this.isJson(ct)) {
      try {
        const j = await res.json();
        if (j && j.error) {
          const code = j.error?.code;
          const msg = String(j.error?.message || '');
          console.warn(`[A2AClient] SSE ${method} JSON-RPC error code=${code} msg=${msg} → fallback`);
        } else {
          console.warn(`[A2AClient] SSE ${method} JSON (not SSE) → fallback`);
        }
      } catch {
        console.warn(`[A2AClient] SSE ${method} JSON parse error → fallback`);
      }
      return;
    }
    if (!this.isSse(ct) || !res.body) { console.warn(`[A2AClient] SSE ${method} unexpected content-type ct=${ct || '(none)'} → fallback`); this.safeCancel(res.body); return; }
    let sawFrame = false;
    try {
      for await (const obj of parseSse<FrameResult>(res.body)) { sawFrame = true; yield obj; }
    } catch {
      // ignore parse errors, treat as failure if no frames
    }
    if (!sawFrame) { console.warn(`[A2AClient] SSE ${method} no frames → fallback`); this.safeCancel(res.body); return; }
  }

  // Resume coordination: when messageSend is called for a task that had
  // paused reconnect (after final:true), notify ticks() to resume.
  private resumePending: Set<string> = new Set();
  private resumeResolvers: Map<string, Array<() => void>> = new Map();
  private notifyResume(taskId: string) {
    const list = this.resumeResolvers.get(taskId);
    if (list && list.length) {
      this.resumeResolvers.delete(taskId);
      for (const fn of list) { try { fn(); } catch {} }
      return;
    }
    this.resumePending.add(taskId);
  }
  private async waitForResume(taskId: string, signal?: AbortSignal) {
    if (this.resumePending.has(taskId)) {
      this.resumePending.delete(taskId);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const arr = this.resumeResolvers.get(taskId) || [];
      arr.push(resolve);
      this.resumeResolvers.set(taskId, arr);
      if (signal) {
        const onAbort = () => {
          // Remove resolver if still present
          const cur = this.resumeResolvers.get(taskId) || [];
          const idx = cur.indexOf(resolve);
          if (idx >= 0) cur.splice(idx, 1);
          if (cur.length) this.resumeResolvers.set(taskId, cur); else this.resumeResolvers.delete(taskId);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async *messageStreamParts(parts: A2APart[], opts:{ taskId?:string; messageId?:string; metadata?: any; signal?:AbortSignal }={}) {
    const msg: any = { kind:'message', role:'user', messageId: opts.messageId || crypto.randomUUID(), ...(opts.taskId ? { taskId: opts.taskId } : {}), parts };
    if (opts.metadata) msg.metadata = opts.metadata;
    const body = { jsonrpc: '2.0', id: crypto.randomUUID(), method: 'message/stream', params: { message: msg } };
    const baseHeaders: Record<string,string> = { 'content-type':'application/json', 'accept':'text/event-stream' };
    const extra = this.getHeaders ? (this.getHeaders() || {}) : {};
    const res = await fetch(this.ep(), { method: 'POST', headers: { ...baseHeaders, ...extra }, body: JSON.stringify(body), signal: opts.signal });
    if (!res.ok || !res.body) throw new Error('message/stream failed: ' + res.status);
    for await (const obj of parseSse<FrameResult>(res.body)) yield obj;
  }
  async *tasksResubscribe(taskId: string, signal?: AbortSignal) {
    const methods = ['tasks/resubscribe', 'tasks/subscribe'] as const;
    for (const method of methods) {
      let handled = false;
      for await (const obj of this.trySse(method, taskId, signal)) { handled = true; yield obj; }
      if (handled) return;
    }
    yield* this.pollTask(taskId, 2000, signal);
  }

  private async *pollTask(taskId: string, intervalMs = 2000, signal?: AbortSignal): AsyncGenerator<A2AStatusUpdate> {
    while (!signal?.aborted) {
      try {
        console.log(`[A2AClient] polling tasks/get id=${taskId}`);
        const t = await this.tasksGet(taskId);
        if (t) {
          const st = (t as any)?.status?.state as string | undefined;
          const ev: A2AStatusUpdate = {
            kind: 'status-update',
            taskId: t.id,
            contextId: t.contextId,
            status: t.status as any,
            final: this.isTerminal(st),
          };
          yield ev;
          if (ev.final || String(st || '').toLowerCase() === 'input-required') return;
        }
      } catch (e) {
        if (signal?.aborted) return;
      }
      await sleep(intervalMs, signal);
    }
  }
  // Resilient resubscribe ticks with backoff - pauses reconnect on final:true
  // Automatically resumes after the next message is sent for this task
  async *ticks(taskId: string, signal?: AbortSignal): AsyncGenerator<void> {
    let attempt = 0;
    let pauseReconnect = false;
    
    while (!signal?.aborted) {
      try {
        // Per-subscribe abort controller so we can end stream on input-required
        const subscribeAbort = new AbortController();
        const onOuterAbort = () => { try { subscribeAbort.abort((signal as any)?.reason) } catch {} };
        try { signal?.addEventListener('abort', onOuterAbort, { once: true }); } catch {}
        for await (const event of this.tasksResubscribe(taskId, subscribeAbort.signal)) {
          attempt = 0; // got data -> reset backoff
          let isFinal = false;
          let isInputReq = false;
          if (event && typeof event === 'object' && 'kind' in event && event.kind === 'status-update') {
            isFinal = (event as A2AStatusUpdate).final === true;
            isInputReq = String((event as any)?.status?.state || '') === 'input-required';
          }
          // Always yield the tick so the app can refresh
          yield;
          // Then decide whether to end this subscribe cycle
          if (isFinal || isInputReq) {
            pauseReconnect = true;
            if (isInputReq) { try { subscribeAbort.abort('input-required'); } catch {} }
            break;
          }
        }
        
        // Stream closed normally
        if (pauseReconnect) {
          // Wait until a new message is sent for this task, then resume
          await this.waitForResume(taskId, signal);
          pauseReconnect = false;
          attempt = 0;
          continue;
        }
        
      } catch (err) {
        if (signal?.aborted) break;
        console.warn('[ticks] stream error', err);
      }
      
      // Backoff and retry if not paused
      if (!pauseReconnect && !signal?.aborted) {
        const ms = Math.min(10000, 500 * 2 ** Math.min(attempt++, 5));
        await sleep(ms, signal);
      }
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
        for await (const ev of parseSse<any>(res.body)) {
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
    const baseHeaders: Record<string,string> = { 'content-type':'application/json' };
    const extra = this.getHeaders ? (this.getHeaders() || {}) : {};
    const res = await fetch(this.ep(), { method:'POST', headers: { ...baseHeaders, ...extra }, body: JSON.stringify(body) });
    const j = await res.json();
    return j.result || null;
  }
  async cancel(taskId: string) {
    const body = { jsonrpc:'2.0', id: crypto.randomUUID(), method: 'tasks/cancel', params: { id: taskId } };
    const baseHeaders: Record<string,string> = { 'content-type':'application/json' };
    const extra = this.getHeaders ? (this.getHeaders() || {}) : {};
    await fetch(this.ep(), { method:'POST', headers: { ...baseHeaders, ...extra }, body: JSON.stringify(body) });
  }
  async messageSend(parts: A2APart[], opts:{ taskId?:string; messageId?:string; metadata?: any }): Promise<A2ATask> {
    const msg: any = { kind:'message', role:'user', taskId: opts.taskId, messageId: opts.messageId || crypto.randomUUID(), parts };
    if (opts.metadata) msg.metadata = opts.metadata;
    const body = { jsonrpc:'2.0', id: crypto.randomUUID(), method: 'message/send', params: { message: msg } };
    const baseHeaders: Record<string,string> = { 'content-type':'application/json' };
    const extra = this.getHeaders ? (this.getHeaders() || {}) : {};
    const res = await fetch(this.ep(), { method:'POST', headers: { ...baseHeaders, ...extra }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('message/send failed: ' + res.status);
    const j = await res.json();
    if (j && j.error) {
      const msg = String(j.error?.message || 'JSON-RPC error');
      throw new Error(`message/send JSON-RPC error: ${msg}`);
    }
    const task = j.result as A2ATask;
    // If this was a send to an existing task, notify ticks() to resume
    if (opts.taskId) {
      try { this.notifyResume(opts.taskId); } catch {}
    }
    return task;
  }
}

// removed legacy SSE parsers in favor of shared parseSse

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { try { clearTimeout(t); } catch {}; rej(signal.reason); }, { once: true });
  });
}
