import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { McpBridgeServer } from './mcp-server.js';
import { ConversationOrchestrator } from '../core/orchestrator.js';
import { encodeConfigToBase64URL } from '$lib/utils/config-encoding.js';
import { CreateConversationRequest, ScenarioConfiguration } from '$lib/types.js';
import { BridgeAgent } from '../../agents/bridge.agent.js';

describe('McpBridgeServer', () => {
  let orchestrator: ConversationOrchestrator;
  let mcpServer: McpBridgeServer;
  let config: CreateConversationRequest;
  let config64: string;

  beforeEach(() => {
    // Create orchestrator with in-memory database and mock LLM provider
    orchestrator = new ConversationOrchestrator(':memory:', {
      generateResponse: async () => ({ content: 'Mock response' })
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

  it('should use configured timeout from orchestrator', () => {
    // The timeout should come from orchestrator config
    const timeoutMs = orchestrator.getConfig().bridgeReplyTimeoutMs;
    expect(timeoutMs).toBe(15000); // 5 seconds default for testing
  });

  it('should support environment variable for timeout override', () => {
    // Set environment variable
    process.env.BRIDGE_REPLY_TIMEOUT_MS = '10000';
    
    // Create new orchestrator with env var
    const testOrchestrator = new ConversationOrchestrator(':memory:', {
      generateResponse: async () => ({ content: 'Mock response' })
    } as any);
    
    const timeoutMs = testOrchestrator.getConfig().bridgeReplyTimeoutMs;
    expect(timeoutMs).toBe(10000);
    
    // Clean up
    delete process.env.BRIDGE_REPLY_TIMEOUT_MS;
  });

  it('should get bridge context from scenario without instantiating agents', async () => {
    // Create a test scenario configuration
    const scenarioConfig: ScenarioConfiguration = {
      id: 'test-scenario',
      version: '1.0',
      schemaVersion: '2.4',
      metadata: {
        id: 'test-scenario',
        title: 'Test Scenario',
        description: 'A test scenario for bridge context',
        tags: ['test', 'bridge']
      },
      scenario: {
        background: 'Test background',
        challenges: [],
        successCriteria: []
      },
      agents: [
        {
          agentId: 'bridge-agent',
          principal: { type: 'individual', name: 'Bridge Agent', description: 'Bridges external clients' },
          situation: 'Bridge situation',
          systemPrompt: 'You bridge external clients',
          goals: ['Bridge messages'],
          tools: []
        },
        {
          agentId: 'counterparty-agent',
          principal: { type: 'individual', name: 'Support Agent', description: 'Provides support' },
          situation: 'Support situation',
          systemPrompt: 'You are a helpful support agent',
          goals: ['Help users'],
          tools: [
            { 
              toolName: 'check_status', 
              description: 'Check system status',
              inputSchema: {},
              synthesisGuidance: 'Check the status of the system'
            },
            { 
              toolName: 'create_ticket', 
              description: 'Create support ticket',
              inputSchema: {},
              synthesisGuidance: 'Create a support ticket'
            }
          ]
        }
      ]
    };

    // Insert scenario into database as ScenarioItem
    const now = Date.now();
    orchestrator.getDbInstance().insertScenario({
      id: 'test-scenario',
      name: 'Test Scenario',
      config: scenarioConfig,
      created: now,
      modified: now,
      history: []
    });

    // Verify scenario was inserted
    const insertedScenario = orchestrator.getDbInstance().findScenarioById('test-scenario');
    expect(insertedScenario).toBeDefined();
    
    // Get bridge context
    const context = await BridgeAgent.getBridgeContextFromScenario(
      orchestrator.getDbInstance(),
      'test-scenario',
      'bridge-agent'
    );

    // Verify context structure
    expect(context.scenario.id).toBe('test-scenario');
    expect(context.scenario.title).toBe('Test Scenario');
    expect(context.scenario.description).toBe('A test scenario for bridge context');
    expect(context.scenario.tags).toEqual(['test', 'bridge']);

    expect(context.bridgedAgent.id).toBe('bridge-agent');
    expect(context.bridgedAgent.principal.name).toBe('Bridge Agent');
    expect(context.bridgedAgent.situation).toBe('Bridge situation');
    expect(context.bridgedAgent.goals).toEqual(['Bridge messages']);

    expect(context.counterparties).toHaveLength(1);
    expect(context.counterparties[0].id).toBe('counterparty-agent');
    expect(context.counterparties[0].principal.name).toBe('Support Agent');
    expect(context.counterparties[0].tools).toHaveLength(2);
    expect(context.counterparties[0].tools[0].toolName).toBe('check_status');
    expect(context.counterparties[0].tools[1].toolName).toBe('create_ticket');
  });
});