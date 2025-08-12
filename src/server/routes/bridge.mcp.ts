// src/server/routes/bridge.mcp.ts
//
// Route factory remains the same, but now the config64 is a base64url ConversationMeta.
// The diag endpoint reflects that meta.
//

import { Hono } from 'hono';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { LLMProviderManager } from '$src/llm/provider-manager';
import type { RunnerRegistry } from '$src/server/runner-registry';
import { McpBridgeServer } from '$src/server/bridge/mcp-server';
import { HonoIncomingMessage, HonoServerResponse } from '$src/server/bridge/hono-node-adapters';
import { parseConversationMetaFromConfig64 } from '$src/server/bridge/conv-config.types';

export function createBridgeRoutes(orchestrator: OrchestratorService, providerManager: LLMProviderManager, runnerRegistry: RunnerRegistry, replyTimeoutMs?: number) {
  const app = new Hono();

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
        { orchestrator, providerManager, runnerRegistry, ...(replyTimeoutMs !== undefined ? { replyTimeoutMs } : {}) },
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

  app.get('/:config64/mcp/diag', (c) => {
    try {
      const meta = parseConversationMetaFromConfig64(c.req.param('config64'));
      return c.json({
        ok: true,
        meta,
        notes: 'This is a base64url-encoded ConversationMeta payload. begin_chat_thread will use it to create and start a conversation.',
      });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}
