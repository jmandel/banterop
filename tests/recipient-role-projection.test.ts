import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart, openBackend, createMessage } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

async function createPairA2A() {
  const pairId = `t-${crypto.randomUUID()}`;
  await openBackend(S, pairId);
  return { pairId, a2a: `${S.base}/api/rooms/${pairId}/a2a` };
}

describe("Recipient role projection", () => {
  it("labels messages as agent/user from responder's perspective", async () => {
    const { pairId, a2a } = await createPairA2A();

    // Epoch will be created on first send

    const initId = `init:${pairId}#1`;
    const respId = `resp:${pairId}#1`;

    // init sends, then resp sends
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ message: createMessage({ parts:[textPart('from-init','turn')], taskId: initId, messageId: crypto.randomUUID() }), configuration:{ historyLength:10000 } } }) });
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m2', method:'message/send', params:{ message: createMessage({ parts:[textPart('from-resp','turn')], taskId: respId, messageId: crypto.randomUUID() }), configuration:{ historyLength:10000 } } }) });

    const rget = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: respId } }) });
    const j = await rget.json();
    const hist = j.result.history as any[];
    // history should contain both earlier messages except the latest; since resp sent last, latest is resp's message, so history includes init's message
    expect(hist.some((m:any)=>m.parts?.some((p:any)=>p.text==='from-init') && m.role==='agent' && m.taskId===respId)).toBeTrue();
  });
});
