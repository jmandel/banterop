// src/backend/index.ts

import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import { ConversationOrchestrator } from './core/orchestrator.js';
import { HonoWebSocketJsonRpcServer } from './websocket/hono-websocket-server.js';
import { seedDatabase } from './db/seed.js';
import { createScenarioRoutes } from './api/scenarios.js';
import { createLLMRoutes } from './api/llm.js';
import { createLLMProvider } from '$llm/factory.js';
import { LLMProviderConfig, LLMProvider } from 'src/types/llm.types.js';
import {
  CreateConversationRequest,
  StartTurnRequest,
  AddTraceEntryRequest,
  CompleteTurnRequest,
  UserQueryRequest,
  SubscriptionOptions
} from '$lib/types.js';

// Define context variables type for auth
type Variables = {
  auth: {
    agentId: string;
    conversationId: string;
  };
};

// --- 1. Initialization ---

// Define the single source of truth for LLM configuration from environment variables.
const llmConfig: LLMProviderConfig = {
  provider: (process.env.LLM_PROVIDER as any) || 'google',
  apiKey: process.env.GEMINI_API_KEY, // The server's key
  model: process.env.LLM_MODEL || 'gemini-2.5-flash-lite',
};

// Create the single, shared LLM provider instance for the entire app.
const defaultLlmProvider: LLMProvider = createLLMProvider(llmConfig);
console.log(`[Backend] Default LLM Provider initialized: ${llmConfig.provider}`);

// Inject the default LLM provider into the Orchestrator.
const orchestrator = new ConversationOrchestrator(
  './dbs/conversations.db',
  defaultLlmProvider
);
seedDatabase(orchestrator.getDbInstance());

// --- 2. Create the API App (routes at root level) ---
const apiApp = new Hono<{ Variables: Variables }>();

// --- 3. Apply Middleware to API App ---
apiApp.use('*', cors());

// Add request logging middleware for debugging
apiApp.use('*', async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;
  const upgradeHeader = c.req.header('upgrade');
  const connectionHeader = c.req.header('connection');
  
  console.log(`[Backend] ${method} ${path}`);
  if (upgradeHeader?.toLowerCase() === 'websocket') {
    console.log('[Backend] WebSocket upgrade request detected');
    console.log('[Backend] Upgrade header:', upgradeHeader);
    console.log('[Backend] Connection header:', connectionHeader);
  }
  
  await next();
});

// --- 4. Auth middleware for protected agent endpoints ---
const authMiddleware = async (c: Context<{ Variables: Variables }>, next: () => Promise<void>) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return c.json({ error: 'No token provided' }, 401);

  const auth = orchestrator.validateAgentToken(token);
  if (!auth) return c.json({ error: 'Invalid token' }, 401);

  c.set('auth', auth);
  await next();
};

// --- 5. Setup WebSocket and Mount Modular Routes ---
console.log('[Backend] Creating WebSocket server instance');
const wsServer = new HonoWebSocketJsonRpcServer(orchestrator);
console.log('[Backend] Mounting WebSocket routes at /ws');
apiApp.route('/ws', wsServer.getApp()); // WebSocket at /ws
console.log('[Backend] WebSocket routes mounted successfully');

console.log('[Backend] Mounting scenario routes at /scenarios');
apiApp.route('/scenarios', createScenarioRoutes(orchestrator.getDbInstance()));
console.log('[Backend] Mounting LLM routes at /llm');
// Inject the single LLM provider instance into the LLM API routes.
apiApp.route('/llm', createLLMRoutes(orchestrator.getDbInstance(), defaultLlmProvider));
console.log('[Backend] All routes mounted successfully');

// --- 6. Core Conversation Endpoints ---

// Public endpoints
apiApp.get('/conversations', async (c) => {
  try {
    const result = orchestrator.getDbInstance().getAllConversations();
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

apiApp.post('/conversations', async (c) => {
  try {
    const request = await c.req.json() as CreateConversationRequest;
    const response = await orchestrator.createConversation(request);
    return c.json(response);
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

apiApp.post('/conversations/:id/start', async (c) => {
  try {
    const conversationId = c.req.param('id');
    await orchestrator.startConversation(conversationId);
    return c.json({ success: true, message: 'Conversation started successfully' });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

apiApp.get('/conversations/:id', async (c) => {
  const conversationId = c.req.param('id');
  const includeTurns = c.req.query('includeTurns') !== 'false';
  const includeTrace = c.req.query('includeTrace') === 'true';
  const includeInProgress = c.req.query('includeInProgress') === 'true';

  const conversation = orchestrator.getConversation(conversationId, includeTurns, includeTrace, includeInProgress);
  if (!conversation) return c.json({ error: 'Conversation not found' }, 404);

  return c.json(conversation);
});

// User query endpoints
apiApp.get('/queries/:id', async (c) => {
  try {
    const queryId = c.req.param('id');
    const response = orchestrator.getUserQueryStatus(queryId);
    return c.json(response);
  } catch (error: any) {
    return c.json({ error: error.message }, 404);
  }
});

apiApp.post('/queries/:id/respond', async (c) => {
  try {
    const queryId = c.req.param('id');
    const { response } = await c.req.json();
    orchestrator.respondToUserQuery(queryId, response);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

// Get all pending queries across the system
apiApp.get('/queries/pending', async (c) => {
  try {
    const queries = orchestrator.getAllPendingUserQueries();
    return c.json({ queries, count: queries.length });
  } catch (error: any) {
    console.error('Error fetching pending queries:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Get pending queries for a specific conversation
apiApp.get('/conversations/:id/queries', async (c) => {
  try {
    const conversationId = c.req.param('id');
    const queries = orchestrator.getPendingUserQueries(conversationId);
    return c.json({ 
      conversationId, 
      queries, 
      count: queries.length 
    });
  } catch (error: any) {
    console.error('Error fetching conversation queries:', error);
    return c.json({ error: error.message }, 500);
  }
});

// SSE endpoint for real-time updates
apiApp.get('/conversations/:id/events', async (c) => {
  const conversationId = c.req.param('id');
  const events = c.req.query('events')?.split(',');
  const agents = c.req.query('agents')?.split(',');
  
  const options: SubscriptionOptions | undefined = (events || agents) ? {
    events: events as any,
    agents
  } : undefined;
  
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = orchestrator.subscribeToConversation(
        conversationId,
        (event) => {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(new TextEncoder().encode(data));
        },
        options
      );

      // Clean up on close
      c.req.raw.signal.addEventListener('abort', () => {
        unsubscribe();
        controller.close();
      });
    }
  });

  return new Response(stream);
});

// == Agent Endpoints (Protected by Auth) ==
apiApp.post('/turns/start', authMiddleware, async (c) => {
  try {
    const auth = c.get('auth');
    const request = await c.req.json() as StartTurnRequest;

    if (request.agentId !== auth.agentId || request.conversationId !== auth.conversationId) {
      return c.json({ error: 'Auth mismatch' }, 403);
    }

    const response = orchestrator.startTurn(request);
    return c.json(response);
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

apiApp.post('/trace', authMiddleware, async (c) => {
  try {
    const auth = c.get('auth');
    const request = await c.req.json() as AddTraceEntryRequest;

    if (request.agentId !== auth.agentId || request.conversationId !== auth.conversationId) {
      return c.json({ error: 'Auth mismatch' }, 403);
    }

    orchestrator.addTraceEntry(request);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

apiApp.post('/turns/complete', authMiddleware, async (c) => {
  try {
    const auth = c.get('auth');
    const request = await c.req.json() as CompleteTurnRequest;

    if (request.agentId !== auth.agentId || request.conversationId !== auth.conversationId) {
      return c.json({ error: 'Auth mismatch' }, 403);
    }

    const turn = orchestrator.completeTurn(request);
    return c.json(turn);
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});


apiApp.post('/queries', authMiddleware, async (c) => {
  try {
    const auth = c.get('auth');
    const request = await c.req.json() as UserQueryRequest;

    if (request.agentId !== auth.agentId || request.conversationId !== auth.conversationId) {
      return c.json({ error: 'Auth mismatch' }, 403);
    }

    const queryId = orchestrator.createUserQuery(request);
    return c.json({ queryId });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

apiApp.post('/conversations/:id/end', authMiddleware, async (c) => {
  try {
    const auth = c.get('auth');
    const conversationId = c.req.param('id');

    if (conversationId !== auth.conversationId) {
      return c.json({ error: 'Conversation mismatch' }, 403);
    }

    orchestrator.endConversation(conversationId);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

// --- 7. Create Main App and Mount API ---
console.log('[Backend] Creating main Hono app');
const app = new Hono();

// Add main app request logging
app.use('*', async (c, next) => {
  console.log(`[Main App] ${c.req.method} ${c.req.path}`);
  await next();
});

console.log('[Backend] Mounting API routes at /api');
app.route('/api', apiApp);
console.log('[Backend] API routes mounted, full path structure:');
console.log('[Backend]   - /api/ws (WebSocket)');
console.log('[Backend]   - /api/scenarios (HTTP)');
console.log('[Backend]   - /api/conversations (HTTP)');
console.log('[Backend]   - /api/llm (HTTP)');

// --- 8. Export server configuration for testing ---
console.log('[Backend] Creating server configuration for export');
export const serverConfig = {
  fetch: app.fetch,
  websocket: wsServer.getWebSocketHandler(),
};
console.log('[Backend] Server configuration created with fetch and websocket handlers');

// --- 9. Start server if this is the main module ---
if (import.meta.main) {
  const port = 3001;
  
  const server = Bun.serve({
    port,
    ...serverConfig,
  });

  console.log(`🚀 Backend API server running! (Simplified Setup)`);
  console.log(`   - HTTP API available at http://localhost:${port}/api`);
  console.log(`   - WebSocket available at ws://localhost:${port}/api/ws`);
}