import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart, openBackend } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe('Resubscribe reconnect', () => {
  it('closing and reopening tasks/resubscribe still yields frames', async () => {
    const r = await fetch(S.base + '/api/pairs', { method:'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = j.endpoints.a2a;
    await openBackend(S, pairId);
    const respId = `resp:${pairId}#1`;

    // Start epoch
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s', method:'message/send', params:{ message:{ parts:[textPart('start','turn')], taskId: `init:${pairId}#1`, messageId: crypto.randomUUID() }, configuration:{ historyLength: 0 } } }) });

    // Open resubscribe and read first snapshot, then abort
    const ac1 = new AbortController();
    const sub1 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, signal: ac1.signal, body: JSON.stringify({ jsonrpc:'2.0', id:'sub1', method:'tasks/resubscribe', params:{ id: respId } }) });
    let gotSnap1 = false;
    for await (const _ of parseSse<any>(sub1.body!)) { gotSnap1 = true; ac1.abort(); break; }
    expect(gotSnap1).toBeTrue();

    // Send another message from responder (turn back), then reopen and expect frames
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', ...require('./utils').leaseHeaders(pairId) }, body: JSON.stringify({ jsonrpc:'2.0', id:'s2', method:'message/send', params:{ message:{ parts:[textPart('pong','turn')], taskId: respId, messageId: crypto.randomUUID() }, configuration:{ historyLength: 0 } } }) });

    const ac2 = new AbortController();
    const sub2 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, signal: ac2.signal, body: JSON.stringify({ jsonrpc:'2.0', id:'sub2', method:'tasks/resubscribe', params:{ id: respId } }) });
    expect(sub2.ok).toBeTrue();
    let gotFrame2 = false;
    for await (const _ of parseSse<any>(sub2.body!)) { gotFrame2 = true; ac2.abort(); break; }
    expect(gotFrame2).toBeTrue();
  });
});
