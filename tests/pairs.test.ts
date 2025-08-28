import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe("Pairs API", () => {
  it("creates a pair and yields endpoints and join links", async () => {
    const r = await fetch(S.base + "/api/pairs", { method: 'POST' });
    expect(r.ok).toBeTrue();
    const j = await r.json();
    expect(j.pairId).toBeString();
    expect(j.endpoints.a2a).toContain(`/api/bridge/${j.pairId}/a2a`);
    expect(j.endpoints.mcp).toContain(`/api/bridge/${j.pairId}/mcp`);
    expect(j.endpoints.agentCard).toContain(`/rooms/${j.pairId}/agent-card.json`);
    expect(j.links.initiator.joinClient).toContain('/client/?card=');
    expect(j.links.initiator.joinMcp).toContain('/client/?mcp=');
    expect(j.links.responder.openRoom).toContain(`/rooms/${j.pairId}`);

    // events.log backlog since=0 contains pair-created as first event
    const ac = new AbortController();
    const es = await fetch(S.base + `/api/pairs/${j.pairId}/events.log?since=0`, { headers: { accept:'text/event-stream' }, signal: ac.signal });
    expect(es.ok).toBeTrue();
    let got = false;
    for await (const ev of parseSse<any>(es.body!)) {
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
