import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart, openBackend } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

async function createPairA2A() {
  const r = await fetch(S.base + "/api/pairs", { method: 'POST' });
  const j = await r.json();
  const pairId = j.pairId as string;
  await openBackend(S, pairId);
  return { pairId, a2a: decodeA2AUrl(j.links.initiator.joinA2a) };
}

describe("Recipient role projection", () => {
  it("labels messages as agent/user from responder's perspective", async () => {
    const { pairId, a2a } = await createPairA2A();

    // ensure epoch exists
    {
      const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s', method:'message/stream', params:{ message:{ role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
      for await (const _ of parseSse<any>(res.body!)) break;
    }

    const initId = `init:${pairId}#1`;
    const respId = `resp:${pairId}#1`;

    // init sends, then resp sends
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ message:{ parts:[textPart('from-init','turn')], taskId: initId, messageId: crypto.randomUUID() }, configuration:{ historyLength:10000 } } }) });
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m2', method:'message/send', params:{ message:{ parts:[textPart('from-resp','turn')], taskId: respId, messageId: crypto.randomUUID() }, configuration:{ historyLength:10000 } } }) });

    const rget = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: respId } }) });
    const j = await rget.json();
    const hist = j.result.history as any[];
    // history should contain both earlier messages except the latest; since resp sent last, latest is resp's message, so history includes init's message
    expect(hist.some((m:any)=>m.parts?.some((p:any)=>p.text==='from-init') && m.role==='agent' && m.taskId===respId)).toBeTrue();
  });
});
