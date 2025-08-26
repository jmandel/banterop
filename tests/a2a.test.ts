import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

async function createPairAndA2A() {
  const r = await fetch(S.base + "/api/pairs", { method: 'POST' });
  const j = await r.json();
  return { pairId: j.pairId as string, a2a: decodeA2AUrl(j.links.initiator.joinA2a) };
}

describe("A2A JSON-RPC", () => {
  it("returns JSON-RPC error on unknown method", async () => {
    const { a2a } = await createPairAndA2A();
    const r = await fetch(a2a, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id: 1, method: 'foo/bar', params: {} }) });
    const j = await r.json();
    expect(j.jsonrpc).toBe('2.0');
    expect(j.error.code).toBe(-32601);
  });

  it("streams JSON-RPC frames; responder mirrors message", async () => {
    const { pairId, a2a } = await createPairAndA2A();
    const reqId = crypto.randomUUID();
    const res = await fetch(a2a, { method: 'POST', headers: { 'content-type': 'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id: reqId, method: 'message/stream', params: { message: { role:'user', parts: [textPart('hi', 'turn')], messageId: crypto.randomUUID() } } }) });
    expect(res.ok).toBeTrue();
    const frames: any[] = [];
    for await (const result of parseSse<any>(res.body!)) {
      frames.push({ result });
      if (frames.length >= 2) break; // snapshot + status-update
    }
    expect(frames[0].result.kind).toBe('task');
    expect(frames[1].result.kind).toBe('status-update');

    // Verify responder sees mirrored message and is input-required
    const respTaskId = `resp:${pairId}#1`;
    const r2 = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id: 2, method:'tasks/get', params: { id: respTaskId } }) });
    const j2 = await r2.json();
    expect(j2.result.status.state).toBe('input-required');
    expect(j2.result.status.message.role).toBe('agent');
    const lastText = (j2.result.status.message.parts||[]).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n');
    expect(lastText).toBe('hi');
  });

  it("message/send returns Task snapshot and enforces FilePart XOR", async () => {
    const { pairId, a2a } = await createPairAndA2A();
    // First start an epoch by streaming empty (creates tasks)
    const res = await fetch(a2a, { method:'POST', headers: { 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id: 's', method:'message/stream', params: { message: { role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
    for await (const _ of parseSse<any>(res.body!)) break; // snapshot only

    // Invalid FilePart (both bytes and uri)
    const bad = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id: 10, method:'message/send', params: { message: { role:'user', parts: [{ kind:'file', file: { name:'x', mimeType:'text/plain', bytes:'QQ==', uri:'http://x' } }], taskId: `init:${pairId}#1`, messageId: crypto.randomUUID() } } }) });
    const jb = await bad.json();
    expect(jb.error.code).toBe(-32602);

    // Valid send should return Task snapshot
    const good = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id: 11, method:'message/send', params: { configuration: { historyLength: 0 }, message: { role:'user', parts: [textPart('ack')], taskId: `init:${pairId}#1`, messageId: crypto.randomUUID() } } }) });
    const jg = await good.json();
    expect(jg.result.kind).toBe('task');
    expect(jg.result.status.message).toBeTruthy();
  });

  it("message/send without taskId creates epoch and uses initiator id", async () => {
    const r = await fetch(S.base + "/api/pairs", { method: 'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);

    // Send without taskId — should auto-create epoch and use init:<pair>#1
    const body = { jsonrpc:'2.0', id:'m0', method:'message/send', params:{ message:{ parts:[textPart('auto turn','turn')], messageId: crypto.randomUUID() }, configuration:{ historyLength: 0 } } };
    const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
    expect(res.ok).toBeTrue();
    const jr = await res.json();
    expect(jr.result.kind).toBe('task');
    expect(String(jr.result.id)).toBe(`init:${pairId}#1`);

    // Responder exists and is input-required
    const respId = `resp:${pairId}#1`;
    const r2 = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: respId } }) });
    const j2 = await r2.json();
    expect(j2.result.id).toBe(respId);
    expect(j2.result.status.state).toBe('input-required');
  });

  it("message/send without taskId starts next epoch if tasks already exist", async () => {
    const r = await fetch(S.base + "/api/pairs", { method: 'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);

    // Create epoch #1 via a no-op stream (no taskId)
    {
      const res = await fetch(a2a, { method:'POST', headers: { 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s', method:'message/stream', params: { message: { role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
      for await (const _ of parseSse<any>(res.body!)) break; // snapshot only
    }

    // Now send without taskId — should bump to epoch #2
    const body = { jsonrpc:'2.0', id:'m1', method:'message/send', params:{ message:{ parts:[textPart('next','turn')], messageId: crypto.randomUUID() }, configuration:{ historyLength: 0 } } };
    const res2 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
    expect(res2.ok).toBeTrue();
    const jr = await res2.json();
    expect(jr.result.kind).toBe('task');
    expect(String(jr.result.id)).toBe(`init:${pairId}#2`);
  });

  it("message/send mirrors message so responder tasks/get has status.message", async () => {
    const { pairId, a2a } = await createPairAndA2A();
    // Start epoch by streaming empty (creates tasks)
    const res = await fetch(a2a, { method:'POST', headers: { 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id: 's', method:'message/stream', params: { message: { role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
    for await (const _ of parseSse<any>(res.body!)) break; // snapshot only

    // Send a message via message/send (turn)
    const send = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:'m', method:'message/send', params:{ message:{ parts:[textPart('hello','turn')], taskId: `init:${pairId}#1`, messageId: crypto.randomUUID() }, configuration:{ historyLength: 0 } } }) });
    expect(send.ok).toBeTrue();

    // Responder should see mirrored message in status.message
    const respTaskId = `resp:${pairId}#1`;
    const r2 = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: respTaskId } }) });
    const j2 = await r2.json();
    expect(j2.result.status.state).toBe('input-required');
    const m = j2.result.status.message;
    expect(!!m).toBeTrue();
    const lastText = (m.parts||[]).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n');
    expect(lastText).toBe('hello');
  });
});
