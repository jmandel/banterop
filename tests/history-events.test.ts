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

describe("Message events and history", () => {
  it("emits type:'message' events and builds history excluding current message", async () => {
    const { pairId, a2a } = await createPairA2A();

    // Epoch will be created on first send below

    const initId = `init:${pairId}#1`;

    // Send first message
    const m1 = crypto.randomUUID();
    {
      const send = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ configuration:{ historyLength: 0 }, message: createMessage({ parts:[textPart('hello-1','turn')], taskId: initId, messageId: m1 }) } }) });
      expect(send.ok).toBeTrue();
    }

    // Backlog should include a type:'message' event with matching messageId and epoch=1
    {
      const ac = new AbortController();
      const es = await fetch(S.base + `/api/rooms/${pairId}/events.log?since=0`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
      expect(es.ok).toBeTrue();
      let found = false;
      for await (const ev of parseSse<any>(es.body!)) {
        if (ev?.type === 'message' && ev.messageId === m1) {
          expect(ev.epoch).toBe(1);
          expect(ev.message?.messageId).toBe(m1);
          found = true;
          try { ac.abort(); } catch {}
          break;
        }
      }
      expect(found).toBeTrue();
    }

    // Snapshot after first send: history should be empty (exclude current)
    {
      const rget = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g1', method:'tasks/get', params:{ id: initId } }) });
      const jg = await rget.json();
      expect(Array.isArray(jg.result.history)).toBeTrue();
      expect(jg.result.history.length).toBe(0);
    }

    // Send second message in same epoch
    const m2 = crypto.randomUUID();
    {
      const send2 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m2', method:'message/send', params:{ configuration:{ historyLength: 0 }, message: createMessage({ parts:[textPart('hello-2','turn')], taskId: initId, messageId: m2 }) } }) });
      expect(send2.ok).toBeTrue();
    }

    // Snapshot after second send: history should include first message only
    {
      const rget2 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g2', method:'tasks/get', params:{ id: initId } }) });
      const jg2 = await rget2.json();
      const hist = jg2.result.history as any[];
      expect(hist.length).toBe(1);
      const ids = hist.map((m:any)=>m.messageId);
      expect(ids.includes(m1)).toBeTrue();
      expect(ids.includes(m2)).toBeFalse();
    }
  });

  it("history is per-epoch; epoch 2 history excludes epoch 1 messages", async () => {
    const { pairId, a2a } = await createPairA2A();

    // Start epoch #1 with a first message
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m0', method:'message/send', params:{ message: createMessage({ parts:[textPart('seed','working')], messageId: crypto.randomUUID() }) } }) });

    const init1 = `init:${pairId}#1`;
    const m1 = crypto.randomUUID();
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ configuration:{ historyLength: 0 }, message: createMessage({ parts:[textPart('e1','turn')], taskId: init1, messageId: m1 }) } }) });

    // Send without taskId to start epoch #2
    const m2 = crypto.randomUUID();
    const send2 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m2', method:'message/send', params:{ configuration:{ historyLength: 0 }, message: createMessage({ parts:[textPart('e2-first','turn')], messageId: m2 }) } }) });
    expect(send2.ok).toBeTrue();
    const jr = await send2.json();
    const init2 = `init:${pairId}#2`;
    expect(String(jr.result.id)).toBe(init2);

    // tasks/get for epoch 2 should have empty history
    const rget = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: init2 } }) });
    const jg = await rget.json();
    expect(Array.isArray(jg.result.history)).toBeTrue();
    expect(jg.result.history.length).toBe(0);
  });
});
