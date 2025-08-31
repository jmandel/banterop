import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, textPart } from "./utils";

let S: Spawned;

beforeAll(async () => { S = await startServer(); });
afterAll(async () => { await stopServer(S); });

describe("Rooms SAB and protocol errors", () => {
  it("backend endpoint responds and normal sends remain functional", async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;
    const url = S.base + `/api/rooms/${pairId}/server-events?mode=backend`;

    const backend = await fetch(url, { headers:{ accept:'text/event-stream' } });
    expect(backend.ok).toBeTrue();

    // A normal send should not be failed when backend is open
    const send = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({
      jsonrpc:'2.0', id:'m', method:'message/send', params:{ message:{ parts:[textPart('ok','working')], messageId: crypto.randomUUID() } }
    }) });
    expect(send.ok).toBeTrue();
    const js = await send.json();
    expect(js.result?.status?.state).not.toBe('failed');
  });
  it("with active backend, message/send follows normal flow (no failed)", async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;

    // Acquire backend lease by opening server-events in backend mode (keep open)
    const url = S.base + `/api/rooms/${pairId}/server-events?mode=backend`;
    const backend = await fetch(url, { headers:{ accept:'text/event-stream' } });
    expect(backend.ok).toBeTrue();

    // Send should not fail when backend is active
    const send = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({
      jsonrpc:'2.0', id:'m', method:'message/send', params:{ message:{ parts:[textPart('go','working')], messageId: crypto.randomUUID() } }
    }) });
    expect(send.ok).toBeTrue();
    const js = await send.json();
    expect(js.result?.status?.state).not.toBe('failed');
    // close
    try { (backend.body as any)?.cancel?.() } catch {}
  });

  it("message/send without backend returns protocol error snapshot with failed state and guidance text", async () => {
    const pairId = `t-${crypto.randomUUID()}`;
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;

    // Send without backend
    const send = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({
      jsonrpc:'2.0', id:'m', method:'message/send', params:{ message:{ parts:[textPart('hello','working')], messageId: crypto.randomUUID() } }
    }) });
    expect(send.ok).toBeTrue();
    const js = await send.json();
    expect(js.result?.status?.state).toBe('failed');
    const m = js.result?.status?.message;
    expect(typeof m?.messageId).toBe('string');
    const txt = (m?.parts||[]).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n');
    expect(txt.toLowerCase()).toContain('backend not open');

    // History should contain the attempted message (not the server error which is latest)
    const hist = js.result?.history || [];
    expect(hist.some((mm:any)=> (mm.parts||[]).some((p:any)=>p.kind==='text' && p.text==='hello'))).toBeTrue();
  });
});
