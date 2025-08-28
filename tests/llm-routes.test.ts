import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startServer, stopServer, Spawned } from "./utils";

let S: Spawned;

describe('LLM routes', () => {
  beforeAll(async () => { S = await startServer(); });
  afterAll(async () => { await stopServer(S); });

  it('lists available providers', async () => {
    const r = await fetch(S.base + '/api/llm/providers');
    expect(r.ok).toBeTrue();
    const arr = await r.json();
    expect(Array.isArray(arr)).toBeTrue();
    const names = arr.map((p:any)=>p.name);
    expect(names.includes('mock')).toBeTrue();
    const mock = arr.find((p:any)=>p.name==='mock');
    expect(Array.isArray(mock.models)).toBeTrue();
    expect(mock.models.includes('mock-model')).toBeTrue();
  });

  it('completes with mock provider', async () => {
    const body = { provider:'mock', model:'mock-model', messages:[{ role:'user', content:'ping' }] };
    const r = await fetch(S.base + '/api/llm/complete', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    expect(r.ok).toBeTrue();
    const j = await r.json();
    expect(typeof j.content).toBe('string');
    expect(j.content.toLowerCase()).toContain('mock response');
  });

  it('validates request body', async () => {
    const r = await fetch(S.base + '/api/llm/complete', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({}) });
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(!!j.error).toBeTrue();
  });
});
