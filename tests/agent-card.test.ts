import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startServer, stopServer, Spawned } from "./utils";

let S: Spawned;
beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe('Per-room agent card', () => {
  it('returns endpoints for the given room', async () => {
    const r = await fetch(S.base + '/api/pairs', { method:'POST' });
    const j = await r.json();
    const roomId = j.pairId as string;
    const res = await fetch(S.base + `/rooms/${roomId}/agent-card.json`);
    expect(res.ok).toBeTrue();
    const card = await res.json();
    expect(card?.name).toBe('flipproxy-room');
    expect(card?.endpoints?.a2a).toBe(`/api/bridge/${roomId}/a2a`);
    expect(card?.endpoints?.mcp).toBe(`/api/bridge/${roomId}/mcp`);
    expect(card?.endpoints?.tasks).toBe(`/api/pairs/${roomId}/server-events`);
  });
});

