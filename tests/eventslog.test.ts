import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, openBackend, createMessage } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe("Control-plane event log", () => {
  it("supports since= backlog replay, reset emits unsubscribe+state, and epoch increments", async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    await openBackend(S, pairId);

    // Create an epoch by sending a first message
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m0', method:'message/send', params:{ message: createMessage({ parts:[{ kind:'text', text:'seed' }], messageId: crypto.randomUUID() }) } }) });

    // Backlog replay from since=0 should include an epoch-begin event
    {
      const ac = new AbortController();
      const es = await fetch(S.base + `/api/rooms/${pairId}/events.log?since=0`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
      expect(es.ok).toBeTrue();
      let got = false;
      for await (const ev of parseSse<any>(es.body!)) {
        if (ev?.type === 'epoch-begin') { got = true; ac.abort(); break; }
      }
      expect(got).toBeTrue();
    }


    // Hard reset: keep same pair, log is cleared, tasks canceled
    const hr = await fetch(S.base + `/api/rooms/${pairId}/reset`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type: 'hard' }) });
    expect(hr.ok).toBeTrue();

    // Verify unsubscribe + combined canceled state after reset
    {
      const ac2 = new AbortController();
      const es2 = await fetch(S.base + `/api/rooms/${pairId}/events.log?since=0`, { headers:{ accept:'text/event-stream' }, signal: ac2.signal });
      let unsub=false, gotCombined=false;
      for await (const ev of parseSse<any>(es2.body!)) {
        if (ev.type === 'backchannel' && ev.action === 'unsubscribe') unsub = true;
        if (ev.type === 'state' && ev.states && ev.states.initiator === 'canceled' && ev.states.responder === 'canceled') {
          gotCombined = true;
        }
        if (unsub && gotCombined) { ac2.abort(); break; }
      }
      expect(unsub && gotCombined).toBeTrue();
    }

    // Determine next epoch: reset-complete reports E, next creation will be E+1
    let resetEpoch = 0;
    {
      const ac3 = new AbortController();
      const es3 = await fetch(S.base + `/api/rooms/${pairId}/events.log?since=0`, { headers:{ accept:'text/event-stream' }, signal: ac3.signal });
      for await (const ev of parseSse<any>(es3.body!)) {
        if (ev.type === 'reset-complete' && typeof ev.epoch === 'number') { resetEpoch = ev.epoch; ac3.abort(); break; }
      }
      expect(resetEpoch).toBeGreaterThan(0);
    }
    const initTaskId2 = `init:${pairId}#${resetEpoch + 1}`;
    {
      // Start next epoch by sending a first message
      await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ message: createMessage({ parts:[{ kind:'text', text:'seed2' }], messageId: crypto.randomUUID() }) } }) });
      const rget = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: initTaskId2 } }) });
      const jg = await rget.json();
      expect(jg.result.id).toBe(initTaskId2);
      expect(jg.result.status.state).toBe('working');
    }
  });
});
