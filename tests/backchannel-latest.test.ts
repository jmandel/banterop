import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart, openBackend } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe('Backchannel emits only latest subscribe on connect', () => {
  it('connect after multiple epochs → first subscribe is for latest epoch', async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;
    await openBackend(S, pairId);

    // Create epoch #1
    {
      const res = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json','accept':'text/event-stream'}, body: JSON.stringify({ jsonrpc:'2.0', id:'s1', method:'message/stream', params:{ message:{ role:'user', parts:[], messageId: crypto.randomUUID() } } }) });
      for await (const _ of parseSse<any>(res.body!)) break;
    }
    // Bump to epoch #2 via send without taskId
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ message:{ parts:[textPart('ep2','turn')], messageId: crypto.randomUUID() } } }) });
    // Bump to epoch #3 via send without taskId
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m2', method:'message/send', params:{ message:{ parts:[textPart('ep3','turn')], messageId: crypto.randomUUID() } } }) });

    // Connect backchannel server-events
    const ac = new AbortController();
    const es = await fetch(S.base + `/api/rooms/${pairId}/server-events`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
    expect(es.ok).toBeTrue();
    let first: any = null;
    for await (const ev of parseSse<any>(es.body!)) { first = ev; break; }
    ac.abort();
    expect(first?.type).toBe('subscribe');
    expect(first?.epoch).toBe(3);
    expect(String(first?.taskId)).toBe(`resp:${pairId}#3`);
  });
});
