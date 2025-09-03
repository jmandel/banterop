import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, openBackend } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe('events.log invariants', () => {
  it('seq increases and since avoids duplicates after activity', async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    await openBackend(S, pairId);

    // Create an epoch to seed the log
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m0', method:'message/send', params:{ message: { kind:'message', role:'user', parts:[{ kind:'text', text:'seed' }], messageId: crypto.randomUUID() } } }) });

    // Read first event to get baseline seq
    let firstSeq = 0;
    {
      const ac = new AbortController();
      const es = await fetch(S.base + `/api/rooms/${pairId}/events.log?since=0&backlogOnly=1`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
      for await (const ev of parseSse<any>(es.body!)) { firstSeq = Number(ev?.seq || 0); ac.abort(); break; }
      expect(firstSeq).toBeGreaterThan(0);
    }

    // Cause activity by issuing a hard reset (emits unsubscribe/state/reset-complete)
    await fetch(`${S.base}/api/rooms/${pairId}/reset`, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ type: 'hard' }) });

    // Fetch backlog again and assert latest seq increased
    {
      const es = await fetch(S.base + `/api/rooms/${pairId}/events.log?since=0&backlogOnly=1`, { headers:{ accept:'text/event-stream' } });
      let lastSeq = 0;
      for await (const ev of parseSse<any>(es.body!)) { lastSeq = Number(ev?.seq || 0); }
      expect(lastSeq).toBeGreaterThan(firstSeq);
    }
  });
});
