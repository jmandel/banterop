import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startServer, stopServer, Spawned, decodeA2AUrl, openBackend } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe("nextState metadata placement", () => {
  it("message-level metadata controls nextState when present (no per-part metadata)", async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;
    await openBackend(S, pairId);
    const initId = `init:${pairId}#1`;
    const respId = `resp:${pairId}#1`;

    // Send with message-level metadata only: nextState=working (handoff)
    const body = {
      jsonrpc: '2.0', id: 'm1', method: 'message/send',
      params: {
        message: {
          taskId: initId,
          messageId: crypto.randomUUID(),
          metadata: { 'https://chitchat.fhir.me/a2a-ext': { nextState: 'working' } },
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
    const pairId = `t-${crypto.randomUUID()}`;
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;
    await openBackend(S, pairId);
    const initId = `init:${pairId}#1`;
    const respId = `resp:${pairId}#1`;

    // message-level nextState=input-required; per-part incorrectly says completed; message-level should win → keep open
    const body = {
      jsonrpc: '2.0', id: 'm2', method: 'message/send',
      params: {
        message: {
          taskId: initId,
          messageId: crypto.randomUUID(),
          metadata: { 'https://chitchat.fhir.me/a2a-ext': { nextState: 'input-required' } },
          parts: [{ kind:'text', text:'hi', metadata: { 'https://chitchat.fhir.me/a2a-ext': { nextState: 'completed' } } }]
        },
        configuration: { historyLength: 0 }
      }
    } as any;
    const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
    expect(res.ok).toBeTrue();

    // With nextState=input-required: initiator should be input-required; responder working
    const gi = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'gi', method:'tasks/get', params:{ id: initId } }) });
    const jgi = await gi.json();
    expect(jgi.result.status.state).toBe('input-required');
    const gr = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'gr', method:'tasks/get', params:{ id: respId } }) });
    const jgr = await gr.json();
    expect(jgr.result.status.state).toBe('working');
  });
});
