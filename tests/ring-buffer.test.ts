import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart } from "./utils";

let S: Spawned;

// Event store enforces a minimum of 100; use 100 to keep the loop modest
beforeAll(async () => { S = await startServer({ env: { FLIPPROXY_EVENTS_MAX: '100' } }); });
afterAll(async () => { await stopServer(S); });

describe("Event ring buffer trims old events", () => {
  it("keeps only the most recent N per pair", async () => {
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);

    // Start epoch (adds epoch-begin)
    {
      const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s', method:'message/stream', params:{ message:{ role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
      for await (const _ of parseSse<any>(res.body!)) break;
    }

    const initId = `init:${pairId}#1`;
    // Generate many events: each send produces a state + message event
    for (let i = 0; i < 60; i++) {
      const msgId = crypto.randomUUID();
      const rsend = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:`m${i}`, method:'message/send', params:{ configuration:{ historyLength: 0 }, message:{ parts:[textPart(`m${i}`,'turn')], taskId: initId, messageId: msgId } } }) });
      expect(rsend.ok).toBeTrue();
    }

    // Backlog since=0 should be limited by ring max (100) and not include the original pair-created
    const ac = new AbortController();
    const es = await fetch(S.base + `/api/pairs/${pairId}/events.log?since=0`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
    expect(es.ok).toBeTrue();
    const collected: any[] = [];
    for await (const ev of parseSse<any>(es.body!)) {
      collected.push(ev);
      if (collected.length >= 100) { try { ac.abort(); } catch {}; break; }
    }
    // Should have exactly 100 backlog items (trimmed to cap)
    expect(collected.length).toBe(100);
    // Oldest events like pair-created should have been trimmed
    expect(collected.some((e:any)=>e.type === 'pair-created')).toBeFalse();
    // Should include at least one message event from the recent sends
    expect(collected.some((e:any)=>e.type === 'message')).toBeTrue();
  });
});
