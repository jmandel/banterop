import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readSSE } from "../src/shared/a2a-utils";
import { startServer, stopServer, Spawned, decodeA2AUrl } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe("Pairs API", () => {
  it("creates a pair and yields join URLs and backchannel", async () => {
    const r = await fetch(S.base + "/api/pairs", { method: 'POST' });
    expect(r.ok).toBeTrue();
    const j = await r.json();
    expect(j.pairId).toBeString();
    expect(j.initiatorJoinUrl).toContain('role=initiator');
    expect(j.responderJoinUrl).toContain('role=responder');
    expect(j.serverEventsUrl).toContain(`/pairs/${j.pairId}/server-events`);

    // events.log backlog since=0 contains pair-created as first event
    const ac = new AbortController();
    const es = await fetch(S.base + `/pairs/${j.pairId}/events.log?since=0`, { headers: { accept:'text/event-stream' }, signal: ac.signal });
    expect(es.ok).toBeTrue();
    let got = false;
    for await (const data of readSSE(es)) {
      const ev = JSON.parse(data).result;
      expect(ev.pairId).toBe(j.pairId);
      expect(typeof ev.seq).toBe('number');
      expect(ev.type).toBe('pair-created');
      got = true;
      ac.abort();
      break;
    }
    expect(got).toBeTrue();
  });
});

