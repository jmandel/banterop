// src/server/routes/bridge.mcp.ts
//
// Route factory remains the same, but now the config64 is a base64url ConversationMeta.
// The diag endpoint reflects that meta.
//

import type { LLMProviderManager } from '$src/llm/provider-manager';
import { HonoIncomingMessage, HonoServerResponse } from '$src/server/bridge/hono-node-adapters';
import { McpBridgeServer } from '$src/server/bridge/mcp-server';
import type { ServerAgentLifecycleManager } from '$src/server/control/server-agent-lifecycle';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

export function createBridgeRoutes(orchestrator: OrchestratorService, providerManager: LLMProviderManager, lifecycle: ServerAgentLifecycleManager, replyTimeoutMs?: number) {
  const app = new Hono();
  // Enable CORS when mounted standalone (e.g., tests)
  app.use('*', cors({ origin: (origin) => origin ?? '*', credentials: true }));

  app.all('/:config64/mcp', async (c) => {
    try {
      const config64 = c.req.param('config64');
      let body: any = undefined;
      if (c.req.method === 'POST') {
        try {
          body = await c.req.json();
        } catch {
          body = undefined;
        }
      }

      const bridge = new McpBridgeServer(
        { orchestrator, providerManager, lifecycle, ...(replyTimeoutMs !== undefined ? { replyTimeoutMs } : {}) },
        config64,
        `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      );

      const req = new HonoIncomingMessage(c, body);
      const res = new HonoServerResponse(c);
      
      // Create a promise that resolves when the response is finished
      const responsePromise = new Promise<Response>((resolve) => {
        res.on('finish', () => {
          // The response has been set on c.res by HonoServerResponse
          resolve(c.res);
        });
      });
      
      // Start handling the request
      // The MCP SDK expects Node.js IncomingMessage and ServerResponse
      // Our adapters implement the necessary interfaces
      await bridge.handleRequest(req, res, body);
      
      // Wait for and return the response
      return await responsePromise;
    } catch (err) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
          id: null,
        },
        500
      );
    }
  });

  return app;
}
