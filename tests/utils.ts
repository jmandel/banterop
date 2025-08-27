import { afterAll, beforeAll, expect } from "bun:test";

import { createServer } from "../src/server/index.ts";

export type Spawned = { server: ReturnType<typeof createServer>; port: number; base: string; dbPath?: string };

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

export async function stopServer(s: Spawned) { try { (s.server as any).stop?.(); } catch {} }

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
