import { Hono } from 'hono';
import { App } from './app';
import { createWebSocketServer } from './ws/jsonrpc.server';
import { createConversationRoutes } from './routes/conversations.http';

// Create singleton app instance
const appInstance = new App();

const server = new Hono();

// Mount REST routes with shared orchestrator
server.route('/', createConversationRoutes(appInstance.orchestrator));

// Mount WebSocket server with shared orchestrator
server.route('/', createWebSocketServer(appInstance.orchestrator));

// Health check
server.get('/health', (c) => c.json({ ok: true }));

// Graceful shutdown
process.on('SIGTERM', async () => {
  await appInstance.shutdown();
  process.exit(0);
});

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: server.fetch,
};