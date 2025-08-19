import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { App } from '$src/server/app';
import { createScenarioRoutes } from '$src/server/routes/scenarios.http';

describe('Scenarios HTTP guard', () => {
  let app: App;
  let server: any;
  let base: string;
  const OLD_TOKEN = process.env.PUBLISHED_EDIT_TOKEN;

  beforeEach(() => {
    // Enable token guard
    process.env.PUBLISHED_EDIT_TOKEN = 'secret-token';
    app = new App({ dbPath: ':memory:' });
    const hono = new Hono().route('/api/scenarios', createScenarioRoutes(app.orchestrator.storage.scenarios));
    server = Bun.serve({ port: 0, fetch: hono.fetch });
    base = `http://localhost:${server.port}`;

    // Seed two scenarios: one published, one normal
    app.orchestrator.storage.scenarios.insertScenario({
      id: 'published_one',
      name: 'Published One',
      config: { metadata: { id: 'published_one', title: 'Published One', description: '', tags: ['published'] }, agents: [] },
      history: [],
    });
    app.orchestrator.storage.scenarios.insertScenario({
      id: 'normal_one',
      name: 'Normal One',
      config: { metadata: { id: 'normal_one', title: 'Normal One', description: '' }, agents: [] },
      history: [],
    });
  });

  afterEach(async () => {
    server.stop();
    await app.shutdown();
    if (OLD_TOKEN === undefined) delete process.env.PUBLISHED_EDIT_TOKEN; else process.env.PUBLISHED_EDIT_TOKEN = OLD_TOKEN;
  });

  it('rejects PUT on published without token (423), accepts with correct token', async () => {
    const noToken = await fetch(`${base}/api/scenarios/published_one`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(noToken.status).toBe(423);
    const wrong = await fetch(`${base}/api/scenarios/published_one`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Token': 'nope' },
      body: JSON.stringify({ name: 'Y' }),
    });
    expect(wrong.status).toBe(423);
    const ok = await fetch(`${base}/api/scenarios/published_one`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Token': 'secret-token' },
      body: JSON.stringify({ name: 'Published OK' }),
    });
    expect(ok.ok).toBe(true);
    const got = await fetch(`${base}/api/scenarios/published_one`);
    const json = await got.json();
    expect(json.name).toBe('Published OK');
  });

  it('allows PUT on non-published without token', async () => {
    const res = await fetch(`${base}/api/scenarios/normal_one`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.ok).toBe(true);
    const got = await fetch(`${base}/api/scenarios/normal_one`);
    const json = await got.json();
    expect(json.name).toBe('Renamed');
  });

  it('rejects DELETE on published without token (423), accepts with correct token', async () => {
    const noToken = await fetch(`${base}/api/scenarios/published_one`, { method: 'DELETE' });
    expect(noToken.status).toBe(423);
    const ok = await fetch(`${base}/api/scenarios/published_one`, { method: 'DELETE', headers: { 'X-Edit-Token': 'secret-token' } });
    expect(ok.ok).toBe(true);
  });
});

