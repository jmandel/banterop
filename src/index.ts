import { serve } from 'bun';
import apiServer, { app as honoApp } from '$src/server/index.ts';
import { serveStatic } from 'hono/bun';

// HTML routes for dev mode (Bun will bundle client assets referenced by these)
import scenarios from '$src/frontend/scenarios/index.html';
import watch from '$src/frontend/watch/index.html';
import clientHtml from '$src/frontend/client/index.html';

// Determine if we're in dev or prod mode
// Bun supports NODE_ENV for Node.js compatibility
const isDev = (Bun.env.NODE_ENV || process.env.NODE_ENV) !== 'production';
const port = Number(process.env.PORT ?? 3000);

let server;

if (isDev) {
  // Development mode: serve HTML directly with HMR
  server = serve({
    port,
    development: {
      hmr: true,
      console: true,
    },
    routes: {
      '/': scenarios,
      '/scenarios/': scenarios,
      '/watch/': watch,
      '/client/': clientHtml,
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
  
} else {
  // Production mode: build frontends with env injection, then serve statically
  
  const apiBase = process.env.PUBLIC_API_BASE_URL || '/api';
  
  // Build all frontends with PUBLIC_API_BASE_URL injected
  console.log(`Building frontends with API_BASE=${apiBase}...`);
  const { buildAllFrontends } = await import('../scripts/build-frontend.ts');
  await buildAllFrontends(apiBase);
  
  // Add static serving middleware to the Hono app
  honoApp.use('/*', serveStatic({ root: './public' }));
  
  server = serve({
    port,
    fetch: (req, srv) => honoApp.fetch(req, srv),
    websocket: apiServer.websocket,
  });
}

const mode = isDev ? 'Dev' : 'Prod';
console.log(`${mode} server listening on ${server.url} (NODE_ENV=${Bun.env.NODE_ENV || 'development'})`);
