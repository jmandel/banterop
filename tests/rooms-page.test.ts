import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startServer, stopServer, Spawned } from "./utils";

let S: Spawned;
beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe('Rooms page', () => {
  it('serves HTML for /rooms/:roomId', async () => {
    const roomId = `t-${crypto.randomUUID()}`;
    const res = await fetch(S.base + `/rooms/${roomId}`);
    expect(res.ok).toBeTrue();
    const ct = res.headers.get('content-type') || '';
    expect(ct.toLowerCase()).toContain('text/html');
  });
});
