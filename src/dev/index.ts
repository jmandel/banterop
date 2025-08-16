import { serve } from 'bun';
import apiServer from '$src/server/index.ts';

// HTML routes (Bun will bundle client assets referenced by these)
import home from './home.html';
import scenarios from '$src/frontend/scenarios/index.html';
import watch from '$src/frontend/watch/index.html';
import debugUi from '$src/frontend/debug/index.html';
import a2aClient from '$src/frontend/a2a-client/index.html';

// Full-stack dev server: static HTML at "/" and API proxied under "/api"
const server = serve({
  port: Number(process.env.PORT ?? 3000),
  development: {
    hmr: true,
    console: true,
  },
  routes: {
    '/': home,
    '/scenarios': scenarios,
    '/scenarios/': scenarios,
    '/watch': watch,
    '/watch/': watch,
    '/frontends/debug': debugUi,
    '/frontends/debug/': debugUi,
    '/debug': debugUi,
    '/a2a-client': a2aClient,
  },
  async fetch(req, srv) {
    const url = new URL(req.url);
    // Delegate API + WS endpoints to existing Hono app
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // Important: pass Bun's server/env so Hono's bun adapter gets c.env
      return (apiServer as any).fetch(req, srv);
    }
    return new Response('Not Found', { status: 404 });
  },
  websocket: apiServer.websocket,
});

console.log(`Dev server listening on ${server.url}`);
