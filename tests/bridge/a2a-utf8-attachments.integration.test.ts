import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { App } from '$src/server/app';
import { createA2ARoutes } from '$src/server/routes/bridge.a2a';
import { websocket } from '$src/server/ws/jsonrpc.server';

function toBase64Url(obj: any): string {
  const json = JSON.stringify(obj);
  // Use TextEncoder + btoa to avoid Buffer (match server approach)
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Minimal SSE reader for tests
async function readSseFrames(res: Response, maxFrames = 1, timeoutMs = 3000): Promise<any[]> {
  const frames: any[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const start = Date.now();
  while (frames.length < maxFrames && Date.now() - start < timeoutMs) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      try {
        const json = JSON.parse(dataLine.replace(/^data:\s*/, ''));
        frames.push(json);
      } catch {}
      if (frames.length >= maxFrames) break;
    }
  }
  try { reader.releaseLock(); } catch {}
  return frames;
}

describe('A2A Bridge UTF-8 attachment encoding', () => {
  let app: App;
  let server: any;
  let baseUrl: string;

  beforeAll(() => {
    app = new App({ dbPath: ':memory:' });
    const hono = new Hono();
    hono.route('/api/bridge', createA2ARoutes(app.orchestrator, app.lifecycleManager));
    server = Bun.serve({ port: 0, fetch: hono.fetch, websocket });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop();
    await app.shutdown();
  });

  it('streams initial frame when message includes UTF-8 attachment bytes', async () => {
    const meta = {
      title: 'UTF8 Attach',
      startingAgentId: 'user',
      agents: [ { id: 'user' }, { id: 'echo', agentClass: 'EchoAgent' } ],
    };
    const config64 = toBase64Url(meta);
    const utf8Text = 'Vision – Résumé — µ Ω café';
    const bytes = utf8ToBase64(utf8Text);
    const res = await fetch(`${baseUrl}/api/bridge/${config64}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'sse-utf8', method: 'message/stream',
        params: { message: { parts: [
          { kind: 'text', text: 'hello with file' },
          { kind: 'file', file: { name: 'utf8.md', mimeType: 'text/markdown', bytes } }
        ] } }
      })
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.includes('text/event-stream')).toBe(true);
    const frames = await readSseFrames(res, 1, 3000);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const first = frames[0];
    expect(first?.jsonrpc).toBe('2.0');
    expect(first?.result?.kind).toBe('task');
    const history = first?.result?.history || [];
    expect(Array.isArray(history)).toBe(true);
    const userWithFile = history.find((m: any) => m.role === 'user' && (m.parts || []).some((p: any) => p.kind === 'file'));
    expect(!!userWithFile).toBe(true);
    // Close stream to end test
    try { await res.body?.cancel(); } catch {}
  });
});

