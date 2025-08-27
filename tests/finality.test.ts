import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

async function tasksGet(a2a: string, id: string) {
  const r = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id } }) });
  const j = await r.json();
  return j.result;
}

describe('Finality transitions', () => {
  it("nextState=input-required keeps responder working and initiator input-required", async () => {
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);
    const initId = `init:${pairId}#1`;
    const respId = `resp:${pairId}#1`;

    // message/send with finality=none should create epoch and apply states
    const send = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s', method:'message/send', params:{ message:{ parts:[textPart('hi','input-required')], taskId: initId, messageId: crypto.randomUUID() }, configuration:{ historyLength: 0 } } }) });
    expect(send.ok).toBeTrue();

    const ti = await tasksGet(a2a, initId);
    const tr = await tasksGet(a2a, respId);
    expect(ti.status.state).toBe('input-required');
    expect(tr.status.state).toBe('working');
  });

  it("nextState=working flips turn: responder input-required then initiator input-required", async () => {
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);
    const initId = `init:${pairId}#1`;
    const respId = `resp:${pairId}#1`;

    // Initiator sends with finality=turn → responder input-required, initiator working
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s1', method:'message/send', params:{ message:{ parts:[textPart('one','working')], taskId: initId, messageId: crypto.randomUUID() }, configuration:{ historyLength: 0 } } }) });
    const r1 = await tasksGet(a2a, respId);
    expect(r1.status.state).toBe('input-required');
    const i1 = await tasksGet(a2a, initId);
    expect(i1.status.state).toBe('working');

    // Responder replies with finality=turn
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s2', method:'message/send', params:{ message:{ parts:[textPart('two','working')], taskId: respId, messageId: crypto.randomUUID() }, configuration:{ historyLength: 0 } } }) });
    const r2 = await tasksGet(a2a, initId);
    expect(r2.status.state).toBe('input-required');
  });

  it("nextState=completed completes both", async () => {
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);
    const initId = `init:${pairId}#1`;
    const respId = `resp:${pairId}#1`;

    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s3', method:'message/send', params:{ message:{ parts:[textPart('bye','completed')], taskId: initId, messageId: crypto.randomUUID() }, configuration:{ historyLength: 0 } } }) });
    const ti = await tasksGet(a2a, initId);
    const tr = await tasksGet(a2a, respId);
    expect(ti.status.state).toBe('completed');
    expect(tr.status.state).toBe('completed');
  });
});
