import { Hono } from 'hono';
import { McpBridgeServer } from '../bridge/mcp-server.js';
import { ConversationOrchestrator } from '../core/orchestrator.js';
import { decodeConfigFromBase64URL } from '$lib/utils/config-encoding.js';
import { validateCreateConversationConfigV2 } from '$lib/utils/config-validation.js';
import { 
  HonoIncomingMessage, 
  HonoServerResponse
} from '../bridge/hono-node-adapters.js';

export function createBridgeRoutes(orchestrator: ConversationOrchestrator) {
  const app = new Hono();

  // MCP server endpoint - handles both POST and GET for SSE
  app.all('/:config64/mcp', async (c) => {
    try {
      const config64 = c.req.param('config64');
      
      // Decode config to get scenario ID
      const config = decodeConfigFromBase64URL(config64);
      const scenarioId = config.metadata.scenarioId || 'unknown';
      
      // Create a unique session ID for this request
      const sessionId = `mcp-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      
      // Create MCP bridge server for this request
      const mcpBridge = new McpBridgeServer(
        orchestrator,
        scenarioId,
        config64,
        sessionId
      );
      
      // Parse body first if it's a POST request, before creating adapters
      let requestBody = null;
      if (c.req.method === 'POST') {
        requestBody = await c.req.json();
      }
      
      // Create a unified response adapter that can handle both JSON and SSE
      const res = new HonoServerResponse(c);
      const req = new HonoIncomingMessage(c, requestBody);
      
      // Set up promise to wait for the response to be written
      const responsePromise = new Promise<Response>((resolve, reject) => {
        res.once('close', () => {
          console.log('[Bridge] Response close event received');
          if (c.res) {
            console.log('[Bridge] Response found on context');
            resolve(c.res);
          } else {
            console.log('[Bridge] Response not set on context');
            reject(new Error('Response not set after close'));
          }
        });
      });
      
      // Start handling the request - the transport will decide JSON vs SSE
      mcpBridge.handleRequest(req, res, requestBody).catch(err => {
        console.error('[Bridge] Error in handleRequest:', err);
      });
      
      // Wait for the response to be ready
      return await responsePromise;
    } catch (error) {
      console.error('MCP bridge error:', error);
      return c.json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal server error'
        },
        id: null
      }, 500);
    }
  });

  // Test SSE endpoint
  app.get('/:config64/mcp/test-sse', async (c) => {
    c.header('Accept', 'text/event-stream');
    return c.text('SSE test endpoint - redirect to /:config64/mcp with Accept: text/event-stream header');
  });

  // Optional diagnostics endpoint (development only)
  app.get('/:config64/mcp/diag', async (c) => {
    try {
      const config64 = c.req.param('config64');
      
      // Decode and validate config
      const config = decodeConfigFromBase64URL(config64);
      const validation = validateCreateConversationConfigV2(config);
      
      return c.json({
        scenarioId: config.metadata.scenarioId,
        config64: config64.substring(0, 50) + '...', // Truncated for display
        configValid: validation.valid,
        errors: validation.errors,
        warnings: validation.warnings,
        config: {
          metadata: config.metadata,
          agentCount: config.agents.length,
          agents: config.agents.map(a => ({
            id: a.id,
            strategyType: a.strategyType,
            shouldInitiateConversation: a.shouldInitiateConversation
          }))
        },
        endpoint: `${c.req.url.replace('/diag', '')}`
      });
    } catch (error) {
      return c.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 400);
    }
  });

  return app;
}