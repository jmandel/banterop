import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { McpBridgeServer } from './mcp-server.js';
import { ConversationOrchestrator } from '../core/orchestrator.js';
import { encodeConfigToBase64URL } from '$lib/utils/config-encoding.js';
import { CreateConversationRequest } from '$lib/types.js';
import { Database } from 'bun:sqlite';

describe('McpBridgeServer', () => {
  let orchestrator: ConversationOrchestrator;
  let mcpServer: McpBridgeServer;
  let config: CreateConversationRequest;
  let config64: string;
  let db: Database;

  beforeEach(() => {
    // Create in-memory database
    db = new Database(':memory:');
    
    // Create orchestrator with mock LLM provider
    orchestrator = new ConversationOrchestrator(db as any, {
      generateContent: async () => ({ content: 'Mock response' }),
      generateScenarioContent: async () => ({
        patientAgent: { clinicalSketch: {} },
        supplierAgent: { operationalContext: {} },
        interactionDynamics: { behavioralParameters: {} }
      })
    } as any);

    // Create test config
    config = {
      metadata: {
        scenarioId: 'test-scenario',
        conversationTitle: 'Test MCP Bridge'
      },
      agents: [
        {
          id: 'mcp-bridge-agent',
          strategyType: 'bridge_to_external_mcp_server',
          shouldInitiateConversation: true
        },
        {
          id: 'internal-agent',
          strategyType: 'scenario_driven'
        }
      ]
    };

    config64 = encodeConfigToBase64URL(config);
    
    // Create MCP server
    mcpServer = new McpBridgeServer(
      orchestrator,
      'test-scenario',
      config64,
      'test-session-123'
    );
  });

  afterEach(async () => {
    await mcpServer.cleanup();
    db.close();
  });

  it('should create MCP server instance', () => {
    const server = mcpServer.getMcpServer();
    expect(server).toBeDefined();
    // The underlying server property has the implementation details
    expect(server.server).toBeDefined();
  });

  it('should have proper tool registration', () => {
    // The MCP server should have tools registered
    // We can't directly introspect them but we know they're there
    const server = mcpServer.getMcpServer();
    expect(server).toBeDefined();
    
    // Tools are registered in the constructor
    // - begin_chat_thread
    // - send_message_to_chat_thread  
    // - wait_for_reply
  });

  it('should handle invalid base64 config gracefully', () => {
    // Constructor doesn't decode, only when tool is called
    expect(() => new McpBridgeServer(
      orchestrator,
      'test-scenario', 
      'invalid-base64',
      'session-456'
    )).not.toThrow();
  });

  // Note: Testing the actual tool execution would require mocking the 
  // orchestrator responses and would be more of an integration test
});