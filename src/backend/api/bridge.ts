import { Hono } from 'hono';
import { McpBridgeServer } from '../bridge/mcp-server.js';
import { ConversationOrchestrator } from '../core/orchestrator.js';
import { decodeConfigFromBase64URL } from '$lib/utils/config-encoding.js';
import { validateCreateConversationConfigV2 } from '$lib/utils/config-validation.js';

export function createBridgeRoutes(orchestrator: ConversationOrchestrator) {
  const app = new Hono();

  // Stateless MCP server endpoint
  app.post('/:config64/mcp', async (c) => {
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
      
      // Get request body as JSON-RPC message
      const requestBody = await c.req.json();
      
      // Handle the JSON-RPC request through MCP server
      const response = await mcpBridge.handleRequest(requestBody);
      
      // Clean up is handled automatically by stateless design
      
      return c.json(response, 200, {
        'Content-Type': 'application/json'
      });
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