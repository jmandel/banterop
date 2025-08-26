import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startServer, stopServer, Spawned, decodeA2AUrl } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe("Finality metadata placement", () => {
  it("message-level metadata controls finality when present (no per-part metadata)", async () => {
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);
    const initId = `init:${pairId}#1`;
    const respId = `resp:${pairId}#1`;

    // Send with message-level metadata only: finality=turn
    const body = {
      jsonrpc: '2.0', id: 'm1', method: 'message/send',
      params: {
        message: {
          taskId: initId,
          messageId: crypto.randomUUID(),
          metadata: { 'https://chitchat.fhir.me/a2a-ext': { finality: 'turn' } },
          parts: [{ kind:'text', text:'hi' }]
        },
        configuration: { historyLength: 0 }
      }
    } as any;
    const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
    expect(res.ok).toBeTrue();

    // Responder should be input-required
    const g = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: respId } }) });
    const jr = await g.json();
    expect(jr.result.status.state).toBe('input-required');
  });

  it("message-level metadata takes precedence over per-part metadata when both provided", async () => {
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);
    const initId = `init:${pairId}#1`;
    const respId = `resp:${pairId}#1`;

    // message-level finality=none; per-part incorrectly says conversation; message-level should win → no flip/end
    const body = {
      jsonrpc: '2.0', id: 'm2', method: 'message/send',
      params: {
        message: {
          taskId: initId,
          messageId: crypto.randomUUID(),
          metadata: { 'https://chitchat.fhir.me/a2a-ext': { finality: 'none' } },
          parts: [{ kind:'text', text:'hi', metadata: { 'https://chitchat.fhir.me/a2a-ext': { finality: 'conversation' } } }]
        },
        configuration: { historyLength: 0 }
      }
    } as any;
    const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
    expect(res.ok).toBeTrue();

    // With finality none: initiator should be input-required; responder working
    const gi = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'gi', method:'tasks/get', params:{ id: initId } }) });
    const jgi = await gi.json();
    expect(jgi.result.status.state).toBe('input-required');
    const gr = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'gr', method:'tasks/get', params:{ id: respId } }) });
    const jgr = await gr.json();
    expect(jgr.result.status.state).toBe('working');
  });
});
