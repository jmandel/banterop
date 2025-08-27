import { afterAll, beforeAll, expect } from "bun:test";

import { createServer } from "../src/server/index.ts";

export type Spawned = { server: ReturnType<typeof createServer>; port: number; base: string; dbPath?: string };
const __openBackends: Array<Response> = [];

export async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 10000, intervalMs = 100): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// No longer used by default; Bun will choose a free port for us when PORT=0
export function randomPort(): number { return 3000 + Math.floor(Math.random() * 3000); }

export async function startServer(opts?: { dbPath?: string; env?: Record<string,string> }): Promise<Spawned> {
  // Programmatically start server with a free port
  if (opts?.env) { for (const [k,v] of Object.entries(opts.env)) { try { (process as any).env[k] = v } catch {} } }
  const server = createServer({ port: 0, env: { FLIPPROXY_DB: opts?.dbPath ?? ':memory:', ...(opts?.env || {}) } });
  const base = String(server.url);
  // Probe readiness
  const ok = await waitUntil(async () => {
    try { const r = await fetch(base + "/.well-known/agent-card.json"); return r.ok; } catch { return false; }
  }, 15000, 100);
  if (!ok) throw new Error("Server did not start");
  const port = Number(new URL(base).port || '0');
  return { server, port, base, dbPath: opts?.dbPath };
}

export async function stopServer(s: Spawned) { try { __openBackends.splice(0).forEach(res => { try { (res.body as any)?.cancel?.() } catch {} }); } catch {} try { (s.server as any).stop?.(); } catch {} }

export function decodeA2AUrl(joinUrl: string): string {
  const u = new URL(joinUrl);
  const a2a = u.searchParams.get("a2a") || "";
  return decodeURIComponent(a2a);
}

export function textPart(text: string, nextState: 'working'|'input-required'|'completed'|'canceled'|'failed'|'rejected'|'auth-required' = 'input-required') {
  return { kind: 'text', text, metadata: { 'https://chitchat.fhir.me/a2a-ext': { nextState } } } as any;
}

export function tmpDbPath(): string {
  const name = `db-${Math.random().toString(36).slice(2,9)}.sqlite`;
  // Prefer OS tmpdir to avoid cluttering repo root
  const tmp = (Bun as any).tmpdir?.() || process.env.TMPDIR || "/tmp";
  return `${tmp}/${name}`;
}

// Open a backend lease for a room (pairId) and keep it until stopServer
export async function openBackend(s: Spawned, pairId: string) {
  const url = `${s.base}/api/pairs/${pairId}/server-events?mode=backend`;
  const res = await fetch(url, { headers:{ accept:'text/event-stream' } });
  if (!res.ok) throw new Error('failed to open backend');
  __openBackends.push(res);
}
