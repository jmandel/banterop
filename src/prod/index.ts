import { serve } from 'bun';
import apiServer from '$src/server/index.ts';
import { buildAllFrontends } from '../../scripts/build-frontend.ts';

// Serve prebuilt static assets from ./public
const PUBLIC_DIR = new URL('../../public/', import.meta.url);

// Build frontends at startup, driven by PUBLIC_API_BASE_URL
await buildAllFrontends(process.env.PUBLIC_API_BASE_URL || '/api');

const server = serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req, srv) {
    const url = new URL(req.url);
    // API and WS under /api
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return (apiServer as any).fetch(req, srv);
    }
    // Try static file
    try {
      let path = url.pathname;
      if (path.endsWith('/')) path += 'index.html';
      const fileUrl = new URL(`.${path}`, PUBLIC_DIR);
      const file = Bun.file(fileUrl);
      if (await file.exists()) return new Response(file);
      // SPA-style fallback for frontends
      const fallback = Bun.file(new URL('./index.html', new URL(`.${url.pathname.split('/')[1] ?? ''}/`, PUBLIC_DIR)));
      if (await fallback.exists()) return new Response(fallback);
      // Root fallback
      const root = Bun.file(new URL('./index.html', PUBLIC_DIR));
      if (await root.exists()) return new Response(root);
    } catch {}
    return new Response('Not Found', { status: 404 });
  },
  websocket: apiServer.websocket,
});

console.log(`Prod server listening on ${server.url}`);


