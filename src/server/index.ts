import { Hono } from 'hono';
import { App } from './app';
import { createWebSocketServer, websocket } from './ws/jsonrpc.server';
import { createScenarioRoutes } from './routes/scenarios.http';
import { createAttachmentRoutes } from './routes/attachments.http';
import { createLLMRoutes } from './routes/llm.http';
import { createBridgeRoutes } from './routes/bridge.mcp';

// Create singleton app instance
const appInstance = new App();

const server = new Hono();

// HTTP: health under /api
server.get('/api/health', (c) => c.json({ ok: true }));

// HTTP: scenarios CRUD under /api/scenarios
server.route('/api/scenarios', createScenarioRoutes(appInstance.orchestrator.storage.scenarios));

// HTTP: attachments under /api/attachments
server.route('/api', createAttachmentRoutes(appInstance.orchestrator));

// HTTP: LLM helper under /api/llm
server.route('/api', createLLMRoutes(appInstance.providerManager));

// Optional: MCP bridge under /api/bridge/:config64/mcp
server.route('/api/bridge', createBridgeRoutes(appInstance.orchestrator, appInstance.providerManager));

// WS: JSON-RPC under /api/ws (already configured in createWebSocketServer)
server.route('/', createWebSocketServer(appInstance.orchestrator));

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