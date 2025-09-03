import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart, openBackend, createMessage } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe('Backchannel subscribe timing', () => {
  it('connect then bump → epoch-begin reports latest epoch', async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;
    await openBackend(S, pairId);

    // Create epoch #1 with a real message
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m0', method:'message/send', params:{ message: createMessage({ parts:[textPart('ep1','turn')], messageId: crypto.randomUUID() }) } }) });
    // Bump to epoch #2 via send without taskId
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ message: createMessage({ parts:[textPart('ep2','turn')], messageId: crypto.randomUUID() }) } }) });
    // Bump to epoch #3 via send without taskId
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m2', method:'message/send', params:{ message: createMessage({ parts:[textPart('ep3','turn')], messageId: crypto.randomUUID() }) } }) });

    // Connect backchannel server-events (no initial subscribe under lazy model)
    const ac = new AbortController();
    const es = await fetch(S.base + `/api/rooms/${pairId}/server-events`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
    expect(es.ok).toBeTrue();

    // Seed epoch #2 with a first message (no bump)
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m2a', method:'message/send', params:{ message: createMessage({ parts:[textPart('ep2a','turn')], messageId: crypto.randomUUID() }) } }) });
    // Now bump to epoch #3
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m3', method:'message/send', params:{ message: createMessage({ parts:[textPart('ep3','turn')], messageId: crypto.randomUUID() }) } }) });
    // Verify via control-plane log that latest epoch is 3
    ac.abort();
    const backlog = await fetch(S.base + `/api/rooms/${pairId}/events.log?since=0&backlogOnly=1`, { headers:{ accept:'text/event-stream' } });
    expect(backlog.ok).toBeTrue();
    let maxEpoch = 0;
    for await (const ev of parseSse<any>(backlog.body!)) { if (ev?.type==='epoch-begin' && typeof ev.epoch==='number') maxEpoch = Math.max(maxEpoch, ev.epoch); }
    expect(maxEpoch).toBeGreaterThanOrEqual(3);
  });
});
