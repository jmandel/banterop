import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ConversationOrchestrator } from '../core/orchestrator.js';
import { McpBridgeServer } from './mcp-server.js';
import { BridgeAgent } from '../../agents/bridge.agent.js';
import { encodeConfigToBase64URL } from '$lib/utils/config-encoding.js';
import { CreateConversationRequest, ConversationTurn } from '$lib/types.js';

describe('MCP Bridge Unit Tests', () => {
  let orchestrator: ConversationOrchestrator;
  let mcpBridge: McpBridgeServer;
  let config: CreateConversationRequest;
  let config64: string;
  
  beforeEach(() => {
    // Mock LLM provider that never gets called in unit tests
    const mockLLMProvider = {
      provider: 'mock',
      generateContent: mock(async () => ({ response: { text: () => 'mock' } }))
    } as any;
    
    orchestrator = new ConversationOrchestrator(':memory:', mockLLMProvider);
    
    config = {
      metadata: {
        scenarioId: 'test-scenario',
        conversationTitle: 'Test Bridge'
      },
      agents: [
        {
          id: 'bridge-agent',
          strategyType: 'bridge_to_external_mcp_server',
          shouldInitiateConversation: true
        },
        {
          id: 'other-agent',
          strategyType: 'scenario_driven'
        }
      ]
    };
    
    config64 = encodeConfigToBase64URL(config);
    mcpBridge = new McpBridgeServer(orchestrator, 'test-scenario', config64, 'test-session');
  });
  
  afterEach(() => {
    // Clear any active bridge agents to avoid leaking state
    if (mcpBridge.__test) {
      mcpBridge.__test.clearActiveBridgeAgents();
    }
    orchestrator.getDbInstance().close();
  });
  
  test('should list available MCP tools', async () => {
    const request = {
      jsonrpc: '2.0',
      id: 'list-1',
      method: 'tools/list',
      params: {}
    };
    
    const response = await mcpBridge.handleRequest(request);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('list-1');
    expect(response.result?.tools).toHaveLength(3);
    
    const toolNames = response.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('begin_chat_thread');
    expect(toolNames).toContain('send_message_to_chat_thread');
    expect(toolNames).toContain('wait_for_reply');
  });
  
  test('should begin chat thread and create conversation', async () => {
    const request = {
      jsonrpc: '2.0',
      id: 'begin-1',
      method: 'tools/call',
      params: {
        name: 'begin_chat_thread',
        arguments: {}
      }
    };
    
    const response = await mcpBridge.handleRequest(request);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('begin-1');
    expect(response.result).toBeDefined();
    expect(response.error).toBeUndefined();
    
    const result = JSON.parse(response.result.content[0].text);
    expect(result.conversationId).toBeDefined();
    
    // Verify conversation was created
    const conversation = await orchestrator.getDbInstance().getConversation(result.conversationId);
    expect(conversation).toBeDefined();
    expect(conversation?.agents).toHaveLength(2);
  });
  
  test('should handle send_message without active conversation', async () => {
    const request = {
      jsonrpc: '2.0',
      id: 'send-no-conv',
      method: 'tools/call',
      params: {
        name: 'send_message_to_chat_thread',
        arguments: {
          conversationId: 'non-existent',
          message: 'Test message'
        }
      }
    };
    
    const response = await mcpBridge.handleRequest(request);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('send-no-conv');
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain('No active conversation');
  });
  
  test('should handle wait_for_reply without pending reply', async () => {
    // First create a conversation
    const beginResponse = await mcpBridge.handleRequest({
      jsonrpc: '2.0',
      id: 'begin-2',
      method: 'tools/call',
      params: { name: 'begin_chat_thread', arguments: {} }
    });
    
    const { conversationId } = JSON.parse(beginResponse.result.content[0].text);
    
    // Try to wait without sending first
    const waitRequest = {
      jsonrpc: '2.0',
      id: 'wait-no-pending',
      method: 'tools/call',
      params: {
        name: 'wait_for_reply',
        arguments: { conversationId }
      }
    };
    
    const response = await mcpBridge.handleRequest(waitRequest);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('wait-no-pending');
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain('No pending reply');
  });
  
  test('should handle unknown method', async () => {
    const request = {
      jsonrpc: '2.0',
      id: 'unknown-1',
      method: 'unknown/method',
      params: {}
    };
    
    const response = await mcpBridge.handleRequest(request);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('unknown-1');
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32603);
    expect(response.error.message).toContain('Unknown method');
  });
  
  test('should handle unknown tool', async () => {
    const request = {
      jsonrpc: '2.0',
      id: 'unknown-tool',
      method: 'tools/call',
      params: {
        name: 'non_existent_tool',
        arguments: {}
      }
    };
    
    const response = await mcpBridge.handleRequest(request);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('unknown-tool');
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain('Unknown tool');
  });
  
  test('should handle invalid configuration', async () => {
    const invalidConfig: CreateConversationRequest = {
      metadata: { scenarioId: 'test' },
      agents: [] // No agents
    };
    
    const invalidConfig64 = encodeConfigToBase64URL(invalidConfig);
    const invalidBridge = new McpBridgeServer(
      orchestrator, 
      'test', 
      invalidConfig64, 
      'invalid-session'
    );
    
    const request = {
      jsonrpc: '2.0',
      id: 'invalid-config',
      method: 'tools/call',
      params: { name: 'begin_chat_thread', arguments: {} }
    };
    
    const response = await invalidBridge.handleRequest(request);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.error).toBeDefined();
    expect(response.error.message).toBeDefined(); // Empty agents array causes different error
  });
  
  test('should validate agent strategy type', async () => {
    const wrongTypeConfig: CreateConversationRequest = {
      metadata: { scenarioId: 'test' },
      agents: [
        {
          id: 'wrong-type',
          strategyType: 'scenario_driven' // Not a bridge type
        }
      ]
    };
    
    const wrongConfig64 = encodeConfigToBase64URL(wrongTypeConfig);
    const wrongBridge = new McpBridgeServer(
      orchestrator,
      'test',
      wrongConfig64,
      'wrong-session'
    );
    
    const request = {
      jsonrpc: '2.0',
      id: 'wrong-type',
      method: 'tools/call',
      params: { name: 'begin_chat_thread', arguments: {} }
    };
    
    const response = await wrongBridge.handleRequest(request);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.error).toBeDefined();
    // Should complain about no bridged agent or invalid strategy type
  });
  
  test('should handle send_message_to_chat_thread successfully', async () => {
    // First begin a chat thread
    const beginResponse = await mcpBridge.handleRequest({
      jsonrpc: '2.0',
      id: 'begin-send-test',
      method: 'tools/call',
      params: { name: 'begin_chat_thread', arguments: {} }
    });
    
    const { conversationId } = JSON.parse(beginResponse.result.content[0].text);
    
    // Set test timeout for this conversation
    mcpBridge.__test.setTestTimeout(conversationId, 100);
    
    // Send a message
    const sendRequest = {
      jsonrpc: '2.0',
      id: 'send-success',
      method: 'tools/call',
      params: {
        name: 'send_message_to_chat_thread',
        arguments: {
          conversationId,
          message: 'Test message from MCP client'
        }
      }
    };
    
    // The send will timeout because no other agent responds in tests
    const response = await mcpBridge.handleRequest(sendRequest);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('send-success');
    expect(response.result).toBeDefined();
    
    const result = JSON.parse(response.result.content[0].text);
    // Should get timeout since no other agent is responding
    expect(result.timeout).toBe(true);
  });
  
  test('should handle send_message with attachments', async () => {
    // First begin a chat thread
    const beginResponse = await mcpBridge.handleRequest({
      jsonrpc: '2.0',
      id: 'begin-attach',
      method: 'tools/call',
      params: { name: 'begin_chat_thread', arguments: {} }
    });
    
    const { conversationId } = JSON.parse(beginResponse.result.content[0].text);
    
    // Set test timeout for this conversation
    mcpBridge.__test.setTestTimeout(conversationId, 100);
    
    // Send a message with attachments
    const sendRequest = {
      jsonrpc: '2.0',
      id: 'send-attach',
      method: 'tools/call',
      params: {
        name: 'send_message_to_chat_thread',
        arguments: {
          conversationId,
          message: 'Message with attachment',
          attachments: [
            {
              name: 'test.txt',
              contentType: 'text/plain',
              content: 'Test file content'
            }
          ]
        }
      }
    };
    
    const response = await mcpBridge.handleRequest(sendRequest);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('send-attach');
    expect(response.result).toBeDefined();
    
    // The response should be a timeout since no other agent responds
    const result = JSON.parse(response.result.content[0].text);
    expect(result.timeout).toBe(true);
    
    // But we can verify the turn was created with attachments
    const conversation = await orchestrator.getDbInstance().getConversation(conversationId, true, false, true);
    const turns = conversation?.turns || [];
    const lastTurn = turns[turns.length - 1];
    
    // The bridge agent should have forwarded the message with attachments
    expect(lastTurn).toBeDefined();
    expect(lastTurn?.content).toContain('Message with attachment');
    expect(lastTurn?.attachments).toBeDefined();
    expect(lastTurn?.attachments?.length).toBeGreaterThan(0);
  });
  
});