import { afterAll, beforeAll, expect } from "bun:test";

export type Spawned = { proc: ReturnType<typeof Bun.spawn>; port: number; base: string; dbPath?: string };

export async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 10000, intervalMs = 100): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function randomPort(): number { return 3000 + Math.floor(Math.random() * 3000); }

export async function startServer(opts?: { dbPath?: string }): Promise<Spawned> {
  const port = randomPort();
  const env = { ...process.env, PORT: String(port), FLIPPROXY_DB: opts?.dbPath ?? ':memory:' } as Record<string, string>;
  const proc = Bun.spawn(["bun", "src/server/flipproxy.ts"], {
    env,
    stdout: "ignore",
    stderr: "inherit",
  });
  const base = `http://localhost:${port}`;
  const ok = await waitUntil(async () => {
    try { const r = await fetch(base + "/.well-known/agent-card.json"); return r.ok; } catch { return false; }
  }, 15000, 100);
  if (!ok) throw new Error("Server did not start");
  return { proc, port, base, dbPath: opts?.dbPath };
}

export async function stopServer(s: Spawned) { try { s.proc.kill(); } catch {} }

export function decodeA2AUrl(joinUrl: string): string {
  const u = new URL(joinUrl);
  const a2a = u.searchParams.get("a2a") || "";
  return decodeURIComponent(a2a);
}

export function textPart(text: string, finality: 'none'|'turn'|'conversation' = 'none') {
  return { kind: 'text', text, metadata: { 'https://chitchat.fhir.me/a2a-ext': { finality } } } as any;
}

export function tmpDbPath(): string {
  const name = `db-${Math.random().toString(36).slice(2,9)}.sqlite`;
  return `${Bun.cwd || process.cwd()}/${name}`;
}
