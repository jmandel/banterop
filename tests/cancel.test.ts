import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart, openBackend } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe("Cancel semantics", () => {
  it("cancels both sides, responder stream sees status=canceled, and events.log shows unsubscribe + state", async () => {
    // Create pair and start epoch
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    expect(r.ok).toBeTrue();
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);
    await openBackend(S, pairId);
    const initTaskId = `init:${pairId}#1`;
    const respTaskId = `resp:${pairId}#1`;

    // Start epoch by streaming a first message (turn) so both tasks exist
    {
      const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'start', method:'message/stream', params:{ message:{ role:'user', parts:[textPart('hello','turn')], messageId: crypto.randomUUID() } } }) });
      for await (const _ of parseSse<any>(res.body!)) break; // initial snapshot
    }

    // Start responder resubscribe stream
    const acSub = new AbortController();
    const sub = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, signal: acSub.signal, body: JSON.stringify({ jsonrpc:'2.0', id:'sub', method:'tasks/resubscribe', params:{ id: respTaskId } }) });
    expect(sub.ok).toBeTrue();

    // Kick off cancel on initiator task after we consume the first snapshot
    let sawCanceledUpdate = false;
    const reader = (async () => {
      let seenFirst = false;
    for await (const frame of parseSse<any>(sub.body!)) {
      if (!seenFirst) { seenFirst = true; continue; }
      if (frame?.kind === 'status-update' && frame?.status?.state === 'canceled') { sawCanceledUpdate = true; acSub.abort(); break; }
    }
    })();

    // Issue cancel from initiator
    const cancelRes = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'cancel', method:'tasks/cancel', params:{ id: initTaskId } }) });
    expect(cancelRes.ok).toBeTrue();
    const cancelJson = await cancelRes.json();
    expect(cancelJson.result?.status?.state).toBe('canceled');

    // Wait for responder stream to observe canceled status
    await reader;
    expect(sawCanceledUpdate).toBeTrue();

    // Verify events.log shows unsubscribe and combined canceled state
    {
      const ac = new AbortController();
      const es = await fetch(S.base + `/api/pairs/${pairId}/events.log?since=0`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
      expect(es.ok).toBeTrue();
      let unsub=false, combined=false;
      for await (const ev of parseSse<any>(es.body!)) {
        if (ev.type === 'backchannel' && ev.action === 'unsubscribe') unsub = true;
        if (ev.type === 'state' && ev.states && ev.states.initiator === 'canceled' && ev.states.responder === 'canceled') combined = true;
        if (unsub && combined) { ac.abort(); break; }
      }
      expect(unsub && combined).toBeTrue();
    }

    // Verify both tasks are canceled via tasks/get
    {
      const r1 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g1', method:'tasks/get', params:{ id: initTaskId } }) });
      const j1 = await r1.json();
      expect(j1.result.status.state).toBe('canceled');
      const r2 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g2', method:'tasks/get', params:{ id: respTaskId } }) });
      const j2 = await r2.json();
      expect(j2.result.status.state).toBe('canceled');
    }
  });

  it("cancel is idempotent (double cancel keeps tasks canceled)", async () => {
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);
    await openBackend(S, pairId);
    const initTaskId = `init:${pairId}#1`;
    const respTaskId = `resp:${pairId}#1`;

    // Create tasks by sending a no-op stream start
    {
      const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'start', method:'message/stream', params:{ message:{ role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
      for await (const _ of parseSse<any>(res.body!)) break;
    }

    // First cancel
    const c1 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'c1', method:'tasks/cancel', params:{ id: initTaskId } }) });
    expect(c1.ok).toBeTrue();
    const j1 = await c1.json();
    expect(j1.result.status.state).toBe('canceled');

    // Second cancel should also succeed and leave tasks canceled
    const c2 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'c2', method:'tasks/cancel', params:{ id: initTaskId } }) });
    expect(c2.ok).toBeTrue();
    const j2 = await c2.json();
    expect(j2.result.status.state).toBe('canceled');

    const g1 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g1', method:'tasks/get', params:{ id: initTaskId } }) });
    const gg1 = await g1.json();
    expect(gg1.result.status.state).toBe('canceled');
    const g2 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g2', method:'tasks/get', params:{ id: respTaskId } }) });
    const gg2 = await g2.json();
    expect(gg2.result.status.state).toBe('canceled');
  });

  it("after cancel, message/send without taskId starts next epoch", async () => {
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);
    await openBackend(S, pairId);
    const initTaskId = `init:${pairId}#1`;
    const respTaskId = `resp:${pairId}#1`;

    // Create tasks by sending a no-op stream
    {
      const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'start', method:'message/stream', params:{ message:{ role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
      for await (const _ of parseSse<any>(res.body!)) break;
    }

    // Cancel both sides via tasks/cancel
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'c', method:'tasks/cancel', params:{ id: initTaskId } }) });

    // Now send without taskId → should bump epoch to #2 and return init:<pair>#2
    const send = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m0', method:'message/send', params:{ message:{ parts:[textPart('new','turn')], messageId: crypto.randomUUID() }, configuration:{ historyLength: 0 } } }) });
    expect(send.ok).toBeTrue();
    const js = await send.json();
    expect(js.result.id).toBe(`init:${pairId}#2`);
  });
});
