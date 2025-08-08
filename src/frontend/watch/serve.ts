#!/usr/bin/env bun

import { serve } from "bun";

// Serve the frontend watch app with Bun
serve({
  port: 3001,
  async fetch(req) {
    const url = new URL(req.url);
    
    // Proxy API requests to backend
    if (url.pathname.startsWith('/api')) {
      const backendUrl = `http://localhost:3456${url.pathname}${url.search}`;
      return fetch(backendUrl, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
    }

    // Serve static files
    const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = Bun.file(`./src/frontend/watch${filePath}`);
    
    if (await file.exists()) {
      // Set correct content type for known extensions
      const ext = filePath.split('.').pop();
      const contentTypes: Record<string, string> = {
        'html': 'text/html',
        'css': 'text/css',
        'js': 'application/javascript',
        'jsx': 'application/javascript',
        'ts': 'application/typescript',
        'tsx': 'application/typescript',
      };
      
      return new Response(file, {
        headers: {
          'Content-Type': contentTypes[ext || ''] || 'text/plain',
        },
      });
    }
    
    // 404 fallback
    return new Response('Not Found', { status: 404 });
  },
});

console.log('Frontend watch app running at http://localhost:3001');