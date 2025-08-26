import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe('events.log invariants', () => {
  it('seq increases and since avoids duplicates after activity', async () => {
    const r = await fetch(S.base + '/api/pairs', { method:'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;

    // Read first event to get baseline seq
    let firstSeq = 0;
    {
      const ac = new AbortController();
      const es = await fetch(S.base + `/api/pairs/${pairId}/events.log?since=0`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
      for await (const ev of parseSse<any>(es.body!)) { firstSeq = Number(ev?.seq || 0); ac.abort(); break; }
      expect(firstSeq).toBeGreaterThan(0);
    }

    // Cause activity (epoch-begin/backchannel/state/message)
    const a2a = `${S.base}/api/bridge/${pairId}/a2a`;
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json','accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'s', method:'message/stream', params:{ message:{ role:'user', parts: [], messageId: crypto.randomUUID() } } }) });

    // Reconnect since=firstSeq and assert first observed seq > baseline
    {
      const ac = new AbortController();
      const es = await fetch(S.base + `/api/pairs/${pairId}/events.log?since=${firstSeq}`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
      let nextSeq = 0;
      for await (const ev of parseSse<any>(es.body!)) { nextSeq = Number(ev?.seq || 0); ac.abort(); break; }
      expect(nextSeq).toBeGreaterThan(firstSeq);
    }
  });
});
