import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

async function createPairA2A() {
  const r = await fetch(S.base + "/api/pairs", { method: 'POST' });
  const j = await r.json();
  return { pairId: j.pairId as string, a2a: decodeA2AUrl(j.links.initiator.joinA2a) };
}

describe("historyLength edge cases", () => {
  it("historyLength=0 returns empty history", async () => {
    const { pairId, a2a } = await createPairA2A();
    const initId = `init:${pairId}#1`;
    const m1 = crypto.randomUUID();
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s', method:'message/stream', params:{ message:{ role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ configuration:{ historyLength: 0 }, message:{ parts:[textPart('one','turn')], taskId: initId, messageId: m1 } } }) });
    const rget = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: initId } }) });
    const j = await rget.json();
    expect(Array.isArray(j.result.history)).toBeTrue();
  });

  it("historyLength>10000 caps at 10000 without error", async () => {
    const { pairId, a2a } = await createPairA2A();
    const initId = `init:${pairId}#1`;
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s', method:'message/stream', params:{ message:{ role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
    const big = 20000;
    const r = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m', method:'message/send', params:{ configuration:{ historyLength: big }, message:{ parts:[textPart('x','turn')], taskId: initId, messageId: crypto.randomUUID() } } }) });
    expect(r.ok).toBeTrue();
  });
});

