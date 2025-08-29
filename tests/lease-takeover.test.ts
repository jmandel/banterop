import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startServer, stopServer, Spawned } from "./utils";
import { parseSse } from "../src/shared/sse";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

async function readFirstEvent(res: Response): Promise<any> {
  const it = parseSse<any>(res.body!)[Symbol.asyncIterator]();
  const { value } = await it.next();
  return value;
}

describe("Lease management: explicit takeover or leaseId required", () => {
  it("denies backend when a lease exists unless takeover or matching leaseId is provided", async () => {
    // Create a room
    const pairId = `t-${crypto.randomUUID()}`;

    // 1) Acquire initial lease (backend1)
    const url = `${S.base}/api/pairs/${pairId}/server-events?mode=backend`;
    const backend1 = await fetch(url, { headers:{ accept:'text/event-stream' } });
    expect(backend1.ok).toBeTrue();
    const ev1 = await readFirstEvent(backend1);
    expect(ev1?.type).toBe('backend-granted');
    const leaseId = String(ev1?.leaseId || '');
    expect(leaseId.length > 0).toBeTrue();

    // 2) Try to open another backend without takeover or leaseId → denied
    const backend2 = await fetch(url, { headers:{ accept:'text/event-stream' } });
    expect(backend2.ok).toBeTrue();
    const ev2 = await readFirstEvent(backend2);
    expect(ev2?.type).toBe('backend-denied');

    // 3) Rebind with matching leaseId → granted (same lease)
    const rebindUrl = `${S.base}/api/pairs/${pairId}/server-events?mode=backend&leaseId=${encodeURIComponent(leaseId)}`;
    const backend3 = await fetch(rebindUrl, { headers:{ accept:'text/event-stream' } });
    expect(backend3.ok).toBeTrue();
    const ev3 = await readFirstEvent(backend3);
    expect(ev3?.type).toBe('backend-granted');
    expect(String(ev3?.leaseId)).toBe(leaseId);

    // 4) Takeover explicitly → granted with a new lease id
    const takeoverUrl = `${S.base}/api/pairs/${pairId}/server-events?mode=backend&takeover=1`;
    const backend4 = await fetch(takeoverUrl, { headers:{ accept:'text/event-stream' } });
    expect(backend4.ok).toBeTrue();
    const ev4 = await readFirstEvent(backend4);
    expect(ev4?.type).toBe('backend-granted');
    expect(String(ev4?.leaseId)).not.toBe(leaseId);

    // Let Bun/HTTP connection cleanup handle SSE closes; explicit cancel can throw when locked
  });
});
