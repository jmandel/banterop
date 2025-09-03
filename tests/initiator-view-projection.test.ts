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

describe("Initiator view projection", () => {
  it("uses init taskId and preserves messageId in status/history", async () => {
    const { pairId, a2a } = await createPairA2A();
    const initId = `init:${pairId}#1`;

    // Epoch will be created on first send below

    const m1 = crypto.randomUUID();
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ configuration:{ historyLength: 10000 }, message: createMessage({ parts:[textPart('hello','turn')], taskId: initId, messageId: m1 }) } }) });

    const rget = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: initId } }) });
    const jg = await rget.json();
    const sm = jg.result.status.message;
    expect(sm.messageId).toBe(m1);
    expect(sm.taskId).toBe(initId);
  });
});
