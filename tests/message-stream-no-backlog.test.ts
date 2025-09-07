import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, openBackend, textPart, createMessage, leaseHeaders } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

async function readUpTo(res: Response, ac: AbortController, max: number, timeoutMs: number): Promise<any[]> {
  const frames: any[] = [];
  const timer = setTimeout(() => ac.abort(), Math.max(10, timeoutMs));
  try {
    for await (const f of parseSse<any>(res.body!)) {
      frames.push(f);
      if (frames.length >= max) break;
    }
  } catch {}
  try { clearTimeout(timer); } catch {}
  return frames;
}

describe('No backlog leakage across epochs', () => {
  it('message/stream (no taskId) starts new epoch and does not replay prior epoch state events', async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    await openBackend(S, pairId);
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;

    // Seed epoch #1 with a couple of messages to create multiple state events
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s1', method:'message/send', params:{ message: createMessage({ parts:[textPart('e1','working')], messageId: crypto.randomUUID() }) } }) });
    // Responder turn to push another state event
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', ...leaseHeaders(pairId) }, body: JSON.stringify({ jsonrpc:'2.0', id:'s2', method:'message/send', params:{ message: createMessage({ parts:[textPart('r1','working')], taskId: `resp:${pairId}#1`, messageId: crypto.randomUUID() }) } }) });

    // Now start message/stream WITHOUT taskId → should create epoch #2
    const ac = new AbortController();
    const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, signal: ac.signal, body: JSON.stringify({ jsonrpc:'2.0', id:'ms', method:'message/stream', params:{ message: createMessage({ parts:[textPart('e2','working')], messageId: crypto.randomUUID() }) } }) });
    expect(res.ok).toBeTrue();

    // Read up to 2 frames or until timeout; correct behavior yields exactly 1 frame (initial)
    const frames = await readUpTo(res, ac, 2, 150);
    expect(frames.length).toBe(1);
    expect(String(frames[0]?.taskId || '')).toBe(`init:${pairId}#2`);
  });

  it('tasks/resubscribe streams only for target task epoch (no prior-epoch backlog)', async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    await openBackend(S, pairId);
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;

    // Seed epoch #1 with messages (creates multiple state events)
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s1', method:'message/send', params:{ message: createMessage({ parts:[textPart('e1','working')], messageId: crypto.randomUUID() }) } }) });
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', ...leaseHeaders(pairId) }, body: JSON.stringify({ jsonrpc:'2.0', id:'s2', method:'message/send', params:{ message: createMessage({ parts:[textPart('r1','working')], taskId: `resp:${pairId}#1`, messageId: crypto.randomUUID() }) } }) });

    // Start epoch #2 by sending without taskId
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'bump', method:'message/send', params:{ message: createMessage({ parts:[textPart('e2','working')], messageId: crypto.randomUUID() }) } }) });
    const init2 = `init:${pairId}#2`;

    // Now resubscribe to init #2; it should not replay epoch #1 backlog
    const ac = new AbortController();
    const sub = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, signal: ac.signal, body: JSON.stringify({ jsonrpc:'2.0', id:'sub', method:'tasks/resubscribe', params:{ id: init2 } }) });
    expect(sub.ok).toBeTrue();
    const frames = await readUpTo(sub, ac, 2, 150);
    expect(frames.length).toBe(1);
    expect(String(frames[0]?.taskId || '')).toBe(init2);
  });
});
