import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { App } from './app';
import { createWebSocketServer, websocket } from './ws/jsonrpc.server';
import { createScenarioRoutes } from './routes/scenarios.http';
import { createConversationRoutes } from './routes/conversations.http';
import { createAttachmentRoutes } from './routes/attachments.http';
import { createLLMRoutes } from './routes/llm.http';
import { createBridgeRoutes } from './routes/bridge.mcp';
import { createA2ARoutes } from './routes/bridge.a2a';
import { createDebugRoutes } from './routes/debug/index';
import { join } from 'node:path';
import { statSync, readdirSync, readFileSync } from 'node:fs';

// Create singleton app instance
const appInstance = new App();

const server = new Hono();

// Enable CORS for all routes
server.use('*', cors({
  // Reflect request origin to support credentials across any origin
  origin: (origin) => origin ?? '*',
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['*'],
}));

// HTTP: health under /api
server.get('/api/health', (c) => c.json({ ok: true }));

// HTTP: scenarios CRUD under /api/scenarios
server.route('/api/scenarios', createScenarioRoutes(appInstance.orchestrator.storage.scenarios));

// HTTP: conversations list under /api/conversations
server.route('/api/conversations', createConversationRoutes(appInstance.orchestrator));

// HTTP: attachments under /api/attachments
server.route('/api', createAttachmentRoutes(appInstance.orchestrator));

// HTTP: LLM helper under /api/llm
server.route('/api', createLLMRoutes(appInstance.llmProviderManager));

// Optional: MCP bridge under /api/bridge/:config64/mcp
server.route('/api/bridge', createBridgeRoutes(appInstance.orchestrator, appInstance.llmProviderManager, appInstance.lifecycleManager));

// A2A bridge under /api/bridge/:config64/a2a
server.route('/api/bridge', createA2ARoutes(appInstance.orchestrator, appInstance.lifecycleManager));

// Debug API (read-only) under /api/debug
server.route('/api/debug', createDebugRoutes(appInstance.orchestrator));

// Optionally expose LLM debug logs when enabled via env
try {
  const flag = (process.env.DEBUG_LLM_REQUESTS || '').toString().trim();
  const debugEnabled = flag && !/^0|false|off$/i.test(flag);
  const debugDir = (process.env.LLM_DEBUG_DIR || '').toString().trim();
  if (debugEnabled && debugDir) {
    const pageSize = 1000;
    const listDir = (basePath: string, urlPath: string, page: number) => {
      const entries = readdirSync(basePath, { withFileTypes: true });
      const rows = entries
        .map((e) => {
          const p = join(basePath, e.name);
          let t = 0;
          try { t = statSync(p).mtimeMs; } catch {}
          return { name: e.name, isDir: e.isDirectory(), mtime: t };
        })
        .sort((a, b) => b.mtime - a.mtime); // newest first

      const total = rows.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const p = Math.min(Math.max(1, page || 1), pages);
      const start = (p - 1) * pageSize;
      const slice = rows.slice(start, start + pageSize);

      const items = slice.map((r) => {
        const href = (urlPath.replace(/\/?$/, '/')) + encodeURIComponent(r.name) + (r.isDir ? '/' : '');
        const label = r.name + (r.isDir ? '/' : '');
        return `<li><a href="${href}">${label}</a></li>`;
      }).join('\n');

      const navPrev = p > 1 ? `<a href="${urlPath}?page=${p - 1}">Prev</a>` : '';
      const navNext = p < pages ? `<a href="${urlPath}?page=${p + 1}">Next</a>` : '';
      const nav = `<div style="display:flex;gap:12px;align-items:center;">${navPrev}${navPrev && navNext ? ' | ' : ''}${navNext}</div>`;
      const html = `<!doctype html><meta charset="utf-8"/><title>Debug Logs</title>
<h1>Index of ${urlPath}</h1>
${nav}
<ul>${items}</ul>
${nav}`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    };

    server.get('/api/debug-logs', (c) => {
      const page = Number(new URL(c.req.url).searchParams.get('page') || '1');
      return listDir(debugDir, '/api/debug-logs', page);
    });

    server.get('/api/debug-logs/*', (c) => {
      try {
        const u = new URL(c.req.url);
        const page = Number(u.searchParams.get('page') || '1');
        const tail = c.req.path.replace(/^\/api\/debug-logs/, '');
        const cleanTail = tail.replace(/^\/+/, '');
        const target = join(debugDir, cleanTail);
        const st = statSync(target);
        if (st.isDirectory()) {
          const pathForUrl = '/api/debug-logs/' + cleanTail.replace(/\/?$/, '/');
          return listDir(target, pathForUrl, page);
        } else {
          const data = readFileSync(target);
          const ct = /\.(txt|log|json|ndjson)$/i.test(target) ? 'text/plain; charset=utf-8' : 'application/octet-stream';
          return new Response(data, { headers: { 'Content-Type': ct } });
        }
      } catch {
        return c.text('Not found', 404);
      }
    });
  }
} catch {
  // ignore debug route setup errors
}


// WS: JSON-RPC under /api/ws (already configured in createWebSocketServer)
server.route('/', createWebSocketServer(appInstance.orchestrator, appInstance.agentHost, appInstance.lifecycleManager));

// Graceful shutdown
process.on('SIGTERM', async () => {
  await appInstance.shutdown();
  process.exit(0);
});

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: server.fetch,
  websocket,
};
