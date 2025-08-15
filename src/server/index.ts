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
