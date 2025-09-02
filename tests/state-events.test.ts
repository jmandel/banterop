import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart, openBackend, createMessage } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe('State events reflect correct turn semantics and include message text', () => {
  it('state after message/send(working) shows responder=input-required, initiator=working with message text', async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;
    await openBackend(S, pairId);
    

    // Start epoch
    const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s', method:'message/stream', params:{ message: createMessage({ role:'user', parts:[], messageId: crypto.randomUUID() }) } }) });
    for await (const _ of parseSse<any>(res.body!)) break;

    // Send handoff message (nextState=working)
    const send = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m', method:'message/send', params:{ message:{ parts:[textPart('hello-turn','working')], taskId: `init:${pairId}#1`, messageId: crypto.randomUUID() }, configuration:{ historyLength: 0 } } }) });
    expect(send.ok).toBeTrue();

    // Read the next state from events.log
    const ac = new AbortController();
    const es = await fetch(S.base + `/api/rooms/${pairId}/events.log?since=0`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
    expect(es.ok).toBeTrue();
    let lastState: any = null;
    for await (const ev of parseSse<any>(es.body!)) {
      if (ev?.type === 'state') { lastState = ev; break; }
    }
    try { ac.abort(); } catch {}
    expect(lastState).toBeTruthy();
    expect(lastState.states.initiator).toBe('working');
    expect(lastState.states.responder).toBe('input-required');
    const txt = (lastState?.status?.message?.parts||[]).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n');
    expect(txt).toBe('hello-turn');
  });
});
