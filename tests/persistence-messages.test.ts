import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, tmpDbPath, textPart } from "./utils";

let S: Spawned;
let DB: string;

describe("Persistence — messages and state across restart", () => {
  beforeAll(async () => {
    DB = tmpDbPath();
    S = await startServer({ dbPath: DB });
  });
  afterAll(async () => {
    await stopServer(S);
    try {
      const fs = await import('node:fs/promises');
      await fs.rm(DB).catch(()=>{});
      await fs.rm(DB + '-wal').catch(()=>{});
      await fs.rm(DB + '-shm').catch(()=>{});
    } catch {}
  });

  it("reconstructs status and history from DB and seeds SSE on restart", async () => {
    // Create pair and derive endpoints
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    expect(r.ok).toBeTrue();
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);
    const initTaskId = `init:${pairId}#1`;
    const respTaskId = `resp:${pairId}#1`;

    // Send two messages in epoch #1: initiator then responder
    const m1 = `m1:${crypto.randomUUID()}`;
    const send1 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({
      jsonrpc:'2.0', id:'m1', method:'message/send', params:{ message:{ taskId: initTaskId, parts:[textPart('hi','working')], messageId: m1 } }
    }) });
    expect(send1.ok).toBeTrue();
    const j1 = await send1.json();
    expect(j1.result.id).toBe(initTaskId);

    const m2 = `m2:${crypto.randomUUID()}`;
    const send2 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({
      jsonrpc:'2.0', id:'m2', method:'message/send', params:{ message:{ taskId: respTaskId, parts:[textPart('ok','completed')], messageId: m2 } }
    }) });
    expect(send2.ok).toBeTrue();

    // Verify snapshots before restart
    async function getSnap(id:string) {
      const r = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id } }) });
      return r.json();
    }

    const gInitBefore = await getSnap(initTaskId);
    const gRespBefore = await getSnap(respTaskId);

    expect(gInitBefore.result.status.state).toBe('completed');
    expect(gRespBefore.result.status.state).toBe('completed');

    // Initiator view: latest is responder message as agent; history contains only m1 labeled user
    const iStat = gInitBefore.result.status.message;
    expect(iStat.messageId).toBe(m2);
    expect(iStat.role).toBe('agent');
    expect(gInitBefore.result.history.length).toBe(1);
    expect(gInitBefore.result.history[0].messageId).toBe(m1);
    expect(gInitBefore.result.history[0].role).toBe('user');

    // Responder view: latest is responder message as user; history contains m1 labeled agent
    const rStat = gRespBefore.result.status.message;
    expect(rStat.messageId).toBe(m2);
    expect(rStat.role).toBe('user');
    expect(gRespBefore.result.history.length).toBe(1);
    expect(gRespBefore.result.history[0].messageId).toBe(m1);
    expect(gRespBefore.result.history[0].role).toBe('agent');

    // Restart server with same DB
    await stopServer(S);
    S = await startServer({ dbPath: DB });

    const a2a2 = `${S.base}/api/bridge/${pairId}/a2a`;

    // After restart: snapshots reconstructed from DB should match
    async function getSnap2(id:string) {
      const r = await fetch(a2a2, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id } }) });
      return r.json();
    }

    const gInitAfter = await getSnap2(initTaskId);
    const gRespAfter = await getSnap2(respTaskId);

    expect(gInitAfter.result.status.state).toBe('completed');
    expect(gRespAfter.result.status.state).toBe('completed');

    expect(gInitAfter.result.status.message.messageId).toBe(m2);
    expect(gInitAfter.result.status.message.role).toBe('agent');
    expect(gInitAfter.result.history.length).toBe(1);
    expect(gInitAfter.result.history[0].messageId).toBe(m1);
    expect(gInitAfter.result.history[0].role).toBe('user');

    expect(gRespAfter.result.status.message.messageId).toBe(m2);
    expect(gRespAfter.result.status.message.role).toBe('user');
    expect(gRespAfter.result.history.length).toBe(1);
    expect(gRespAfter.result.history[0].messageId).toBe(m1);
    expect(gRespAfter.result.history[0].role).toBe('agent');

    // Verify SSE ring was seeded on startup: epoch-begin, two messages, then a state
    {
      const ac = new AbortController();
      const es = await fetch(S.base + `/api/pairs/${pairId}/events.log?since=0`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
      expect(es.ok).toBeTrue();
      let sawEpoch = false, sawM1 = false, sawM2 = false, sawState = false;
      for await (const ev of parseSse<any>(es.body!)) {
        if (ev.type === 'epoch-begin') sawEpoch = true;
        if (ev.type === 'message' && ev.messageId === m1) sawM1 = true;
        if (ev.type === 'message' && ev.messageId === m2) sawM2 = true;
        if (ev.type === 'state') sawState = true;
        if (sawEpoch && sawM1 && sawM2 && sawState) { ac.abort(); break; }
      }
      expect(sawEpoch && sawM1 && sawM2 && sawState).toBeTrue();
    }
  });

  it("persists multi-epoch history and isolates per-epoch after restart", async () => {
    // New pair
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    expect(r.ok).toBeTrue();
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);

    const init1 = `init:${pairId}#1`;
    const resp1 = `resp:${pairId}#1`;

    // Epoch 1: two messages (init then resp)
    const m1 = `e1:m1:${crypto.randomUUID()}`;
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({
      jsonrpc:'2.0', id:'e1m1', method:'message/send', params:{ message:{ taskId: init1, parts:[textPart('e1-hi','working')], messageId: m1 } }
    }) });

    const m2 = `e1:m2:${crypto.randomUUID()}`;
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({
      jsonrpc:'2.0', id:'e1m2', method:'message/send', params:{ message:{ taskId: resp1, parts:[textPart('e1-ok','completed')], messageId: m2 } }
    }) });

    // Epoch 2: bump by sending without taskId (init), then responder replies
    const m3 = `e2:m1:${crypto.randomUUID()}`;
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({
      jsonrpc:'2.0', id:'e2m1', method:'message/send', params:{ message:{ parts:[textPart('e2-hi','working')], messageId: m3 } }
    }) });

    const init2 = `init:${pairId}#2`;
    const resp2 = `resp:${pairId}#2`;

    const m4 = `e2:m2:${crypto.randomUUID()}`;
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({
      jsonrpc:'2.0', id:'e2m2', method:'message/send', params:{ message:{ taskId: resp2, parts:[textPart('e2-ok','completed')], messageId: m4 } }
    }) });

    // Snapshots before restart
    async function getSnap(id:string) {
      const r = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id } }) });
      return r.json();
    }
    const s1iB = await getSnap(init1);
    const s1rB = await getSnap(resp1);
    const s2iB = await getSnap(init2);
    const s2rB = await getSnap(resp2);

    // Epoch 1 assertions
    expect(s1iB.result.status.state).toBe('completed');
    expect(s1rB.result.status.state).toBe('completed');
    expect(s1iB.result.status.message.messageId).toBe(m2);
    expect(s1iB.result.history.map((m:any)=>m.messageId)).toEqual([m1]);
    expect(s1rB.result.status.message.messageId).toBe(m2);
    expect(s1rB.result.history.map((m:any)=>m.messageId)).toEqual([m1]);

    // Epoch 2 assertions
    expect(s2iB.result.status.state).toBe('completed');
    expect(s2rB.result.status.state).toBe('completed');
    expect(s2iB.result.history.map((m:any)=>m.messageId)).toEqual([m3]);
    expect(s2rB.result.history.map((m:any)=>m.messageId)).toEqual([m3]);

    // Restart server
    await stopServer(S);
    S = await startServer({ dbPath: DB });
    const a2a2 = `${S.base}/api/bridge/${pairId}/a2a`;

    async function getSnap2(id:string) {
      const r = await fetch(a2a2, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id } }) });
      return r.json();
    }

    const s1iA = await getSnap2(init1);
    const s1rA = await getSnap2(resp1);
    const s2iA = await getSnap2(init2);
    const s2rA = await getSnap2(resp2);

    // After restart: epochs preserved; history isolated
    expect(s1iA.result.status.state).toBe('completed');
    expect(s1rA.result.status.state).toBe('completed');
    expect(s1iA.result.history.map((m:any)=>m.messageId)).toEqual([m1]);
    expect(s1rA.result.history.map((m:any)=>m.messageId)).toEqual([m1]);

    expect(s2iA.result.status.state).toBe('completed');
    expect(s2rA.result.status.state).toBe('completed');
    expect(s2iA.result.history.map((m:any)=>m.messageId)).toEqual([m3]);
    expect(s2rA.result.history.map((m:any)=>m.messageId)).toEqual([m3]);

    // SSE seeding only for latest epoch (#2): should see m3 and m4, not m1/m2
    {
      const ac = new AbortController();
      const es = await fetch(S.base + `/api/pairs/${pairId}/events.log?since=0`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
      expect(es.ok).toBeTrue();
      let gotEpoch2 = false, gotM3 = false, gotM4 = false, sawE1 = false, sawState = false;
      for await (const ev of parseSse<any>(es.body!)) {
        if (ev.type === 'epoch-begin' && ev.epoch === 2) gotEpoch2 = true;
        if (ev.type === 'message' && ev.epoch === 1) sawE1 = true;
        if (ev.type === 'message' && ev.messageId === m3) gotM3 = true;
        if (ev.type === 'message' && ev.messageId === m4) gotM4 = true;
        if (ev.type === 'state') sawState = true;
        if (gotEpoch2 && gotM3 && gotM4 && sawState) { ac.abort(); break; }
      }
      expect(sawE1).toBeFalse();
      expect(gotEpoch2 && gotM3 && gotM4 && sawState).toBeTrue();
    }
  });
});
