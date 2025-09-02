import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startServer, stopServer, Spawned, textPart, createMessage } from "./utils";

let S: Spawned;

beforeAll(async () => {
  // Small caps to exercise LRU behavior
  S = await startServer({ env: { BANTEROP_ROOMS_MAX: '3', BANTEROP_EVENTS_MAX: '50' } });
});
afterAll(async () => { await stopServer(S); });

async function sendOne(pairId: string) {
  const a2a = `${S.base}/api/rooms/${pairId}/a2a`;
  // Send without taskId to create epoch and push events
  const msgId = crypto.randomUUID();
  const r = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({
    jsonrpc:'2.0', id:'m', method:'message/send', params:{ configuration:{ historyLength: 0 }, message: createMessage({ parts:[textPart('hi','working')], messageId: msgId }) }
  }) });
  expect(r.ok).toBeTrue();
}

async function backlogCount(pairId: string): Promise<number> {
  const es = await fetch(`${S.base}/api/rooms/${pairId}/events.log?since=0&backlogOnly=1`, { headers:{ accept:'text/event-stream' } });
  if (!es.ok || !es.body) return 0;
  const reader = es.body.getReader();
  const td = new TextDecoder('utf-8');
  let buf = '', count = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += td.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) if (line.startsWith('data:')) count++;
    }
  }
  return count;
}

describe('Rooms LRU eviction', () => {
  it('evicts the least-recently-used room when exceeding max', async () => {
    const r1 = `t-${crypto.randomUUID()}`;
    const r2 = `t-${crypto.randomUUID()}`;
    const r3 = `t-${crypto.randomUUID()}`;
    const r4 = `t-${crypto.randomUUID()}`;
    await sendOne(r1);
    await sendOne(r2);
    await sendOne(r3);
    // Adding a 4th room should evict r1 (LRU order: r1, r2, r3 → evict r1 on r4 touch)
    await sendOne(r4);

    // Read non-evicted rooms first to avoid evicting them by touching r1
    const c2 = await backlogCount(r2);
    const c3 = await backlogCount(r3);
    const c4 = await backlogCount(r4);
    const c1 = await backlogCount(r1);
    expect(c1).toBe(0); // r1 evicted
    expect(c2).toBeGreaterThan(0);
    expect(c3).toBeGreaterThan(0);
    expect(c4).toBeGreaterThan(0);
  });

  it('touching a room protects it from eviction', async () => {
    const a = `t-${crypto.randomUUID()}`;
    const b = `t-${crypto.randomUUID()}`;
    const c = `t-${crypto.randomUUID()}`;
    await sendOne(a); await sendOne(b); await sendOne(c); // LRU: a, b, c
    // Touch 'a' by reading its backlog, promoting it to MRU (LRU becomes: b, c, a)
    await backlogCount(a);
    // Now add d → evict b
    const d = `t-${crypto.randomUUID()}`;
    await sendOne(d);

    const ca = await backlogCount(a);
    const cc = await backlogCount(c);
    const cd = await backlogCount(d);
    const cb = await backlogCount(b);
    expect(cb).toBe(0); // b evicted
    expect(ca).toBeGreaterThan(0);
    expect(cc).toBeGreaterThan(0);
    expect(cd).toBeGreaterThan(0);
  });
});
