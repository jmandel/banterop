import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

async function createPairA2A() {
  const r = await fetch(S.base + "/api/pairs", { method: 'POST' });
  const j = await r.json();
  return { pairId: j.pairId as string, a2a: decodeA2AUrl(j.links.initiator.joinA2a) };
}

describe("Recipient view projection", () => {
  it("preserves messageId, excludes current from history, and uses responder taskId in responder snapshot", async () => {
    const { pairId, a2a } = await createPairA2A();

    // Ensure epoch exists via a no-op stream
    {
      const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s', method:'message/stream', params:{ message:{ role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
      for await (const _ of parseSse<any>(res.body!)) break; // snapshot only
    }

    const initId = `init:${pairId}#1`;
    const respId = `resp:${pairId}#1`;

    // Send first message from initiator
    const m1 = crypto.randomUUID();
    {
      const send = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ configuration:{ historyLength: 10000 }, message:{ parts:[textPart('hello-1','working')], taskId: initId, messageId: m1 } } }) });
      expect(send.ok).toBeTrue();
    }

    // Responder snapshot should have status.message with same messageId and taskId=resp:... and history empty
    {
      const rget = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: respId } }) });
      const jg = await rget.json();
      expect(jg.result.status.state).toBe('input-required');
      const sm = jg.result.status.message;
      expect(sm.messageId).toBe(m1);
      expect(sm.taskId).toBe(respId);
      expect(Array.isArray(jg.result.history)).toBeTrue();
      expect(jg.result.history.length).toBe(0);
    }

    // Send second message from initiator; now responder history should include first message, projected to resp taskId
    const m2 = crypto.randomUUID();
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m2', method:'message/send', params:{ configuration:{ historyLength: 10000 }, message:{ parts:[textPart('hello-2','working')], taskId: initId, messageId: m2 } } }) });

    {
      const rget2 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g2', method:'tasks/get', params:{ id: respId } }) });
      const j2 = await rget2.json();
      const hist = j2.result.history as any[];
      expect(hist.length).toBe(1);
      expect(hist[0].messageId).toBe(m1);
      // taskId should be responder's taskId in the responder view
      expect(hist[0].taskId).toBe(respId);
    }
  });
});
