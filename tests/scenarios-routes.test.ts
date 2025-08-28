import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startServer, stopServer, Spawned } from "./utils";

let S: Spawned;

describe('Scenarios CRUD', () => {
  beforeAll(async () => { S = await startServer(); });
  afterAll(async () => { await stopServer(S); });

  const sample = (id:string) => ({ metadata:{ id, title:`Title ${id}`, tags:[] }, agents:[], tools:[] });

  it('supports list/create/get/update/delete', async () => {
    // Empty list
    let r = await fetch(S.base + '/api/scenarios');
    expect(r.ok).toBeTrue();
    let j = await r.json();
    expect(Array.isArray(j)).toBeTrue();

    // Create
    r = await fetch(S.base + '/api/scenarios', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ config: sample('alpha') }) });
    expect(r.status).toBe(201);
    j = await r.json();
    expect(j?.metadata?.id).toBe('alpha');

    // Get
    r = await fetch(S.base + '/api/scenarios/alpha');
    expect(r.ok).toBeTrue();
    j = await r.json();
    expect(j?.metadata?.id).toBe('alpha');

    // Update
    const updated = { ...sample('alpha'), metadata:{ id:'alpha', title:'New Title', tags:['published'] } };
    r = await fetch(S.base + '/api/scenarios/alpha', { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ config: updated }) });
    expect(r.ok).toBeTrue();
    j = await r.json();
    expect(j?.metadata?.title).toBe('New Title');

    // Delete with guard off (no token, not enforced without env set)
    r = await fetch(S.base + '/api/scenarios/alpha', { method:'DELETE' });
    expect(r.ok).toBeTrue();
  });

  it('enforces edit guard on published when PUBLISHED_EDIT_TOKEN is set', async () => {
    // Start a new server with guard token
    await stopServer(S);
    S = await startServer({ env: { PUBLISHED_EDIT_TOKEN: 'sekret' } });

    // Create published scenario
    let r = await fetch(S.base + '/api/scenarios', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ config: { ...sample('beta'), metadata:{ id:'beta', title:'T', tags:['published'] } } }) });
    expect(r.status).toBe(201);

    // Update without token → 423
    r = await fetch(S.base + '/api/scenarios/beta', { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ config: { ...sample('beta'), metadata:{ id:'beta', title:'X', tags:['published'] } } }) });
    expect(r.status).toBe(423);

    // Update with token → ok
    r = await fetch(S.base + '/api/scenarios/beta', { method:'PUT', headers:{'content-type':'application/json','X-Edit-Token':'sekret'}, body: JSON.stringify({ config: { ...sample('beta'), metadata:{ id:'beta', title:'Y', tags:['published'] } } }) });
    expect(r.ok).toBeTrue();

    // Delete with token → ok
    r = await fetch(S.base + '/api/scenarios/beta', { method:'DELETE', headers:{ 'X-Edit-Token':'sekret' } });
    expect(r.ok).toBeTrue();
  });
});
