import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, openBackend, textPart, createMessage } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe('message/stream epoch semantics', () => {
  it('without taskId creates epoch #1 and uses init:<pair>#1', async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    await openBackend(S, pairId);
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;

    const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s1', method:'message/stream', params:{ message: createMessage({ parts:[textPart('e1','working')], messageId: crypto.randomUUID() }) } }) });
    expect(res.ok).toBeTrue();
    const frames: any[] = [];
    for await (const f of parseSse<any>(res.body!)) { frames.push(f); break; }
    expect(frames.length).toBe(1);
    const taskId = String(frames[0]?.taskId || '');
    expect(taskId).toBe(`init:${pairId}#1`);
  });

  it('without taskId starts next epoch (#2) if current epoch already has messages', async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    await openBackend(S, pairId);
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;

    // Seed epoch #1 with a message (no taskId)
    {
      const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'seed', method:'message/send', params:{ message: createMessage({ parts:[textPart('seed','working')], messageId: crypto.randomUUID() }) } }) });
      expect(res.ok).toBeTrue(); await res.text();
    }

    // Now message/stream without taskId should bump to epoch #2
    const res2 = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s2', method:'message/stream', params:{ message: createMessage({ parts:[textPart('e2','working')], messageId: crypto.randomUUID() }) } }) });
    expect(res2.ok).toBeTrue();
    const frames2: any[] = [];
    for await (const f of parseSse<any>(res2.body!)) { frames2.push(f); break; }
    expect(frames2.length).toBe(1);
    const taskId2 = String(frames2[0]?.taskId || '');
    expect(taskId2).toBe(`init:${pairId}#2`);
  });
});

