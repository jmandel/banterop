import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, openBackend, textPart, createMessage, leaseHeaders } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe('message/stream behavior', () => {
  it('keeps stream open and closes on input-required', async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    await openBackend(S, pairId);
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;

    const initId = `init:${pairId}#1`;
    const respId = `resp:${pairId}#1`;

    // Start message/stream from initiator with next=working (so responder is working; initiator is working as well or not final)
    const stream = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'ms', method:'message/stream', params:{ message: createMessage({ parts:[textPart('q','working')], messageId: crypto.randomUUID() }) } }) });
    expect(stream.ok).toBeTrue();

    const frames: any[] = [];
    const reader = (async () => {
      for await (const f of parseSse<any>(stream.body!)) { frames.push(f); }
    })();

    // Give the stream a moment to deliver the first status update
    await new Promise(r => setTimeout(r, 50));

    // Not final yet
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]?.kind).toBe('status-update');
    expect(frames[0]?.final).toBeFalse();

    // Now send a responder message with next=working to flip initiator to input-required
    const rsend = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', ...leaseHeaders(pairId) }, body: JSON.stringify({ jsonrpc:'2.0', id:'rs', method:'message/send', params:{ message: createMessage({ parts:[textPart('ack','working')], taskId: respId, messageId: crypto.randomUUID() }) } }) });
    expect(rsend.ok).toBeTrue();
    await rsend.text();

    // Wait for the stream to finish
    await reader;

    // Expect the last frame to be final with state input-required for init
    const last = frames.at(-1);
    expect(last?.kind).toBe('status-update');
    expect(last?.status?.state).toBe('input-required');
    expect(last?.final).toBeTrue();
  });

  it('closes immediately when initial state is terminal', async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    await openBackend(S, pairId);
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;

    // Send a completed message; stream should return final immediately
    const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'ms2', method:'message/stream', params:{ message: createMessage({ parts:[textPart('done','completed')], messageId: crypto.randomUUID() }) } }) });
    expect(res.ok).toBeTrue();
    const frames: any[] = [];
    for await (const f of parseSse<any>(res.body!)) { frames.push(f); }
    expect(frames.length).toBe(1);
    expect(frames[0]?.kind).toBe('status-update');
    expect(frames[0]?.final).toBeTrue();
  });
});

describe('tasks/resubscribe final on input-required', () => {
  it('sends final:true and closes when viewer is input-required', async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    await openBackend(S, pairId);
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;
    const initId = `init:${pairId}#1`;
    const respId = `resp:${pairId}#1`;

    // Kick off epoch, initiator sends working
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m0', method:'message/send', params:{ message: createMessage({ parts:[textPart('start','working')], taskId: initId, messageId: crypto.randomUUID() }) } }) });

    // Responder sends working -> initiator becomes input-required
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', ...leaseHeaders(pairId) }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ message: createMessage({ parts:[textPart('back','working')], taskId: respId, messageId: crypto.randomUUID() }) } }) });

    // Resubscribe to initiator taskId; expect one final frame then close
    const sub = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'sub', method:'tasks/resubscribe', params:{ id: initId } }) });
    expect(sub.ok).toBeTrue();
    const frames: any[] = [];
    for await (const f of parseSse<any>(sub.body!)) { frames.push(f); }
    expect(frames.length).toBe(1);
    expect(frames[0]?.kind).toBe('status-update');
    expect(frames[0]?.status?.state).toBe('input-required');
    expect(frames[0]?.final).toBeTrue();
  });
});

