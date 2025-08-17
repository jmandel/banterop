import { serve } from 'bun';
import apiServer from '$src/server/index.ts';

// HTML routes (Bun will bundle client assets referenced by these)
import scenarios from '$src/frontend/scenarios/index.html';
import watch from '$src/frontend/watch/index.html';
import a2aClient from '$src/frontend/a2a-client/index.html';

// Determine if we're in dev or prod mode
// Bun supports NODE_ENV for Node.js compatibility
const isDev = (Bun.env.NODE_ENV || process.env.NODE_ENV) !== 'production';
const port = Number(process.env.PORT ?? 3000);

const server = serve({
  port,
  ...(isDev && {
    development: {
      hmr: true,
      console: true,
    }
  }),
  routes: {
    '/': scenarios,
    '/scenarios/': scenarios,
    '/watch/': watch,
    '/a2a-client/': a2aClient,
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

const mode = isDev ? 'Dev' : 'Prod';
console.log(`${mode} server listening on ${server.url} (NODE_ENV=${Bun.env.NODE_ENV || 'development'})`);