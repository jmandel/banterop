import { afterAll, beforeAll, describe, expect, it } from "bun:test";

type Spawned = { proc: ReturnType<typeof Bun.spawn>; port: number; base: string; db: string };

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 7000, intervalMs = 100) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function randomPort() { return 3000 + Math.floor(Math.random() * 3000); }

function randomDbPath() {
  const suffix = Math.random().toString(36).slice(2);
  return `/tmp/flipproxy_${suffix}.sqlite`;
}

async function startServer(dbPath: string): Promise<Spawned> {
  const port = randomPort();
  const proc = Bun.spawn(["bun", "src/server/flipproxy.ts"], {
    env: { ...process.env, PORT: String(port), FLIPPROXY_DB: dbPath },
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
  return { proc, port, base, db: dbPath };
}

async function stopServer(s: Spawned) {
  try { s.proc.kill(); } catch {}
}

function decodeA2AUrl(joinUrl: string): string {
  const u = new URL(joinUrl);
  const a2a = u.searchParams.get("a2a") || "";
  return decodeURIComponent(a2a);
}

describe("Persistence (bun-storage)", () => {
  let S: Spawned;

  afterAll(async () => { if (S) await stopServer(S); });

  it("persists metadata and can read it back", async () => {
    S = await startServer(randomDbPath());
    const meta = { name: "Test Session", tags: ["persistence","meta"] };
    const r = await fetch(S.base + "/api/pairs", { method: 'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ metadata: meta }) });
    expect(r.ok).toBeTrue();
    const j = await r.json();
    const m = await (await fetch(S.base + `/api/pairs/${j.pairId}/metadata`)).json();
    expect(m.metadata).toEqual(meta);
  });

  it("hydrates pair meta and tasks after restart", async () => {
    // Create pair and start an epoch so tasks exist
    const r = await fetch(S.base + "/api/pairs", { method: 'POST' });
    const j = await r.json();
    const pairId: string = j.pairId;
    const a2a = decodeA2AUrl(j.initiatorJoinUrl);
    // Start epoch by streaming empty message
    const res = await fetch(a2a, { method: 'POST', headers: { 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id: 'start', method:'message/stream', params: { message: { role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
    // Read one frame (snapshot) and close
    const reader = (res.body as any)?.getReader?.();
    try { await reader?.read(); } catch {}
    try { S.proc.kill(); } catch {}

    // Restart server with same DB
    S = await startServer(S.db);
    const initTaskId = `init:${pairId}#1`;
    const rget = await fetch(a2a, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: initTaskId } }) });
    const jg = await rget.json();
    expect(jg.result.id).toBe(initTaskId);
    expect(jg.result.kind).toBe('task');
    expect(jg.result.status.state).toBeDefined();
  });
});

