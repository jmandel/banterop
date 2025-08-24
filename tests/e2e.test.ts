import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readSSE } from "../src/shared/a2a-utils";

type Spawned = { proc: ReturnType<typeof Bun.spawn>; port: number; base: string };

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 7000, intervalMs = 100) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function randomPort() {
  return 3000 + Math.floor(Math.random() * 3000);
}

async function startServer(): Promise<Spawned> {
  const port = randomPort();
  const proc = Bun.spawn(["bun", "src/server/flipproxy.ts"], {
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore",
    stderr: "inherit",
  });
  const base = `http://localhost:${port}`;
  const ok = await waitUntil(async () => {
    try {
      const r = await fetch(base + "/.well-known/agent-card.json");
      return r.ok;
    } catch { return false; }
  }, 10000, 100);
  if (!ok) throw new Error("Server did not start");
  return { proc, port, base };
}

async function stopServer(s: Spawned) {
  try { s.proc.kill(); } catch {}
}

function decodeA2AUrl(joinUrl: string): string {
  const u = new URL(joinUrl);
  const a2a = u.searchParams.get("a2a") || "";
  return decodeURIComponent(a2a);
}

function textPart(text: string, finality: 'none'|'turn'|'conversation' = 'none') {
  return { kind: 'text', text, metadata: { 'https://chitchat.fhir.me/a2a-ext': { finality } } };
}

let S: Spawned;

beforeAll(async () => {
  S = await startServer();
});

afterAll(async () => {
  await stopServer(S);
});

describe("Pairs API", () => {
  it("creates a pair and yields join URLs and backchannel", async () => {
    const r = await fetch(S.base + "/api/pairs", { method: 'POST' });
    expect(r.ok).toBeTrue();
    const j = await r.json();
    expect(j.pairId).toBeString();
    expect(j.initiatorJoinUrl).toContain('role=initiator');
    expect(j.responderJoinUrl).toContain('role=responder');
    expect(j.serverEventsUrl).toContain(`/pairs/${j.pairId}/server-events`);
  });

});

describe("A2A JSON-RPC", () => {
  async function createPairAndA2A() {
    const r = await fetch(S.base + "/api/pairs", { method: 'POST' });
    const j = await r.json();
    return { pairId: j.pairId as string, a2a: decodeA2AUrl(j.initiatorJoinUrl) };
  }

  it("returns JSON-RPC error on unknown method", async () => {
    const { a2a } = await createPairAndA2A();
    const r = await fetch(a2a, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id: 1, method: 'foo/bar', params: {} }) });
    const j = await r.json();
    expect(j.jsonrpc).toBe('2.0');
    expect(j.error.code).toBe(-32601);
  });

  it("streams JSON-RPC frames and correlates id", async () => {
    const { pairId, a2a } = await createPairAndA2A();
    const reqId = crypto.randomUUID();
    const res = await fetch(a2a, { method: 'POST', headers: { 'content-type': 'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id: reqId, method: 'message/stream', params: { message: { role:'user', parts: [textPart('hi', 'turn')], messageId: crypto.randomUUID() } } }) });
    expect(res.ok).toBeTrue();
    const frames: any[] = [];
    for await (const data of readSSE(res)) {
      const obj = JSON.parse(data);
      frames.push(obj);
      if (frames.length >= 2) break; // snapshot + status-update
    }
    expect(frames[0].jsonrpc).toBe('2.0');
    expect(frames[0].id).toBe(reqId);
    expect(frames[0].result.kind).toBe('task');
    expect(frames[1].result.kind).toBe('status-update');

    // Verify responder sees mirrored message and is input-required
    const respTaskId = `resp:${pairId}#1`;
    const r2 = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id: 2, method:'tasks/get', params: { id: respTaskId } }) });
    const j2 = await r2.json();
    expect(j2.result.status.state).toBe('input-required');
    expect(j2.result.status.message.role).toBe('agent');
    const lastText = (j2.result.status.message.parts||[]).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n');
    expect(lastText).toBe('hi');
  });

  it("message/send returns Task snapshot and enforces FilePart XOR", async () => {
    const { pairId, a2a } = await createPairAndA2A();
    // First start an epoch by streaming empty (creates tasks)
    const res = await fetch(a2a, { method:'POST', headers: { 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id: 's', method:'message/stream', params: { message: { role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
    for await (const _ of readSSE(res)) break; // snapshot only

    // Invalid FilePart (both bytes and uri)
    const bad = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id: 10, method:'message/send', params: { message: { role:'user', parts: [{ kind:'file', file: { name:'x', mimeType:'text/plain', bytes:'QQ==', uri:'http://x' } }], taskId: `init:${pairId}#1`, messageId: crypto.randomUUID() } } }) });
    const jb = await bad.json();
    expect(jb.error.code).toBe(-32602);

    // Valid send should return Task snapshot
    const good = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id: 11, method:'message/send', params: { configuration: { historyLength: 0 }, message: { role:'user', parts: [textPart('ack')], taskId: `init:${pairId}#1`, messageId: crypto.randomUUID() } } }) });
    const jg = await good.json();
    expect(jg.result.kind).toBe('task');
    expect(jg.result.status.message).toBeTruthy();
  });

  it("flip semantics: 'turn' passes token initiator -> responder and back", async () => {
    const { pairId, a2a } = await createPairAndA2A();
    const initTaskId = `init:${pairId}#1`;
    const respTaskId = `resp:${pairId}#1`;
    // Start epoch by streaming initiator send with finality=turn
    const reqId = crypto.randomUUID();
    const res = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json','accept':'text/event-stream'}, body: JSON.stringify({ jsonrpc:'2.0', id:reqId, method:'message/stream', params:{ message:{ role:'user', parts:[textPart('hi','turn')], messageId: crypto.randomUUID() } } }) });
    for await (const _ of readSSE(res)) break;
    // Responder should now have the token (input-required) with mirrored message
    const r1 = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'tasks/get', params:{ id: respTaskId } }) });
    const jr1 = await r1.json();
    expect(jr1.result.status.state).toBe('input-required');
    const r1txt = (jr1.result.status.message.parts||[]).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n');
    expect(jr1.result.status.message.role).toBe('agent');
    expect(r1txt).toBe('hi');
    // Responder replies with finality=turn; token should pass back to initiator
    const sendBack = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:2, method:'message/send', params:{ message:{ role:'user', parts:[textPart('pong','turn')], taskId: respTaskId, messageId: crypto.randomUUID() }, configuration:{ historyLength: 0 } } }) });
    await sendBack.json();
    const r2 = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:3, method:'tasks/get', params:{ id: initTaskId } }) });
    const jr2 = await r2.json();
    expect(jr2.result.status.state).toBe('input-required');
    const r2txt = (jr2.result.status.message.parts||[]).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n');
    expect(jr2.result.status.message.role).toBe('agent');
    expect(r2txt).toBe('pong');
  });
});

describe("Control-plane event log", () => {
  it("supports since= backlog replay and hard reset keeps same pair", async () => {
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    expect(r.ok).toBeTrue();
    const j = await r.json();
    const pairId = j.pairId as string;

    // Backlog replay from since=0 should include pair-created as first event
    {
      const ac = new AbortController();
      const es = await fetch(S.base + `/pairs/${pairId}/events.log?since=0`, { headers:{ accept:'text/event-stream' }, signal: ac.signal });
      expect(es.ok).toBeTrue();
      let got = false;
      for await (const data of readSSE(es)) {
        const ev = JSON.parse(data).result;
        expect(ev.pairId).toBe(pairId);
        expect(typeof ev.seq).toBe('number');
        expect(ev.type).toBe('pair-created');
        got = true;
        ac.abort();
        break;
      }
      expect(got).toBeTrue();
    }

    // Start epoch by streaming a no-op message
    const a2a = decodeA2AUrl(j.initiatorJoinUrl);
    {
      const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'start', method:'message/stream', params:{ message:{ role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
    for await (const _ of readSSE(res)) break;
    }

    // Hard reset: keep same pair, log is cleared, tasks canceled
    const hr = await fetch(S.base + `/pairs/${pairId}/reset`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type: 'hard' }) });
    expect(hr.ok).toBeTrue();

    // Verify unsubscribe + two canceled status events after reset
    {
      const ac2 = new AbortController();
      const es2 = await fetch(S.base + `/pairs/${pairId}/events.log?since=0`, { headers:{ accept:'text/event-stream' }, signal: ac2.signal });
      let unsub=false, gotCombined=false;
      for await (const data of readSSE(es2)) {
        const ev = JSON.parse(data).result;
        if (ev.type === 'backchannel' && ev.action === 'unsubscribe') unsub = true;
        if (ev.type === 'state' && ev.states && ev.states.initiator === 'canceled' && ev.states.responder === 'canceled') {
          gotCombined = true;
        }
        if (unsub && gotCombined) { ac2.abort(); break; }
      }
      expect(unsub && gotCombined).toBeTrue();
    }

    // Next initiator send should create epoch #2 task
    const initTaskId2 = `init:${pairId}#2`;
    {
      const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'start2', method:'message/stream', params:{ message:{ role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
      for await (const _ of readSSE(res)) break;
      const rget = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: initTaskId2 } }) });
      const jg = await rget.json();
      expect(jg.result.id).toBe(initTaskId2);
      expect(jg.result.status.state).toBe('submitted');
    }
  });
});
