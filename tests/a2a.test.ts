import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readSSE } from "../src/shared/a2a-utils";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

async function createPairAndA2A() {
  const r = await fetch(S.base + "/api/pairs", { method: 'POST' });
  const j = await r.json();
  return { pairId: j.pairId as string, a2a: decodeA2AUrl(j.initiatorJoinUrl) };
}

describe("A2A JSON-RPC", () => {
  it("returns JSON-RPC error on unknown method", async () => {
    const { a2a } = await createPairAndA2A();
    const r = await fetch(a2a, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id: 1, method: 'foo/bar', params: {} }) });
    const j = await r.json();
    expect(j.jsonrpc).toBe('2.0');
    expect(j.error.code).toBe(-32601);
  });

  it("streams JSON-RPC frames and correlates id; responder mirrors message", async () => {
    const { pairId, a2a } = await createPairAndA2A();
    const reqId = crypto.randomUUID();
    const res = await fetch(a2a, { method: 'POST', headers: { 'content-type': 'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id: reqId, method: 'message/stream', params: { message: { role:'user', parts: [textPart('hi', 'turn')], messageId: crypto.randomUUID() } } }) });
    expect(res.ok).toBeTrue();
    const frames: any[] = [];
    for await (const data of readSSE(res)) {
      const obj = JSON.parse(data);
      frames.push(obj);
      if (frames.length >= 2) break; // snapshot + status-update
    }
    expect(frames[0].jsonrpc).toBe('2.0');
    expect(frames[0].id).toBe(reqId);
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
    for await (const _ of readSSE(res)) break; // snapshot only

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
});

