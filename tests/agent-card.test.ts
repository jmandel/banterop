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
    const res = await fetch(S.base + `/api/rooms/${roomId}/.well-known/agent-card.json`);
    expect(res.ok).toBeTrue();
    const card = await res.json();
    expect(String(card?.name || '')).toContain(`Conversational Interop Room`);
    // Main URL points to alias under /api/rooms/:roomId/a2a
    expect(String(card?.url || '')).toContain(`/api/rooms/${roomId}/a2a`);
    const exts = Array.isArray(card?.capabilities?.extensions) ? card.capabilities.extensions : [];
    const fp = exts.find((e:any)=>String(e?.uri||'')==='https://chitchat.fhir.me/a2a-ext');
    expect(!!fp).toBeTrue();
    expect(String(fp?.params?.a2a || '')).toContain(`/api/rooms/${roomId}/a2a`);
    expect(String(fp?.params?.mcp || '')).toContain(`/api/rooms/${roomId}/mcp`);
    expect(String(fp?.params?.tasks || '')).toContain(`/api/pairs/${roomId}/server-events`);
  });
});
