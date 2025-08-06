import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ConversationOrchestrator } from '../core/orchestrator.js';
import { McpBridgeServer } from './mcp-server.js';
import { BridgeAgent } from '../../agents/bridge.agent.js';
import { encodeConfigToBase64URL } from '$lib/utils/config-encoding.js';
import { CreateConversationRequest, ConversationTurn } from '$lib/types.js';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

describe('MCP Bridge Unit Tests', () => {
  let orchestrator: ConversationOrchestrator;
  let mcpBridge: McpBridgeServer;
  let config: CreateConversationRequest;
  let config64: string;
  
  // Create proper HTTP mocks for the StreamableHTTPServerTransport
  class MockIncomingMessage extends Readable {
    method: string;
    headers: any;
    url: string;
    httpVersion: string;
    complete: boolean;
    
    constructor(method: string, headers: any, body?: any) {
      super();
      this.method = method;
      this.headers = headers;
      this.url = '/';
      this.httpVersion = '1.1';
      this.complete = true;
      
      // Push body if provided
      if (body) {
        this.push(JSON.stringify(body));
      }
      this.push(null);
    }
    
    _read() {}
  }
  
  class MockServerResponse extends EventEmitter {
    statusCode: number;
    statusMessage: string;
    headersSent: boolean;
    _headers: any;
    _data: any[];
    _ended: boolean;
    
    constructor() {
      super();
      this.statusCode = 200;
      this.statusMessage = 'OK';
      this.headersSent = false;
      this._headers = {};
      this._data = [];
      this._ended = false;
    }
    
    writeHead(statusCode: number, statusMessage?: any, headers?: any) {
      this.statusCode = statusCode;
      if (typeof statusMessage === 'string') {
        this.statusMessage = statusMessage;
      } else {
        headers = statusMessage;
      }
      if (headers) {
        Object.assign(this._headers, headers);
      }
      this.headersSent = true;
      return this;
    }
    
    setHeader(name: string, value: any) {
      this._headers[name.toLowerCase()] = value;
      return this;
    }
    
    getHeader(name: string) {
      return this._headers[name.toLowerCase()];
    }
    
    write(chunk: any, encoding?: any) {
      if (chunk) {
        this._data.push(chunk);
      }
      return true;
    }
    
    end(chunk?: any, encoding?: any) {
      if (chunk) {
        this._data.push(chunk);
      }
      this._ended = true;
      this.emit('finish');
      return this;
    }
    
    getData() {
      return this._data.map(d => 
        Buffer.isBuffer(d) ? d.toString() : String(d)
      ).join('');
    }
  }

  // Helper function to make MCP requests
  const makeMcpRequest = async (body: any): Promise<any> => {
    // Create proper HTTP request mock
    const mockReq = new MockIncomingMessage('POST', {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream'
    }, body);
    
    // Create proper HTTP response mock
    const mockRes = new MockServerResponse();
    
    // Call the handler
    await mcpBridge.handleRequest(mockReq, mockRes, body);
    
    // Wait a bit for async operations
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Parse the captured response
    const responseData = mockRes.getData();
    if (responseData) {
      try {
        return JSON.parse(responseData);
      } catch (e) {
        return responseData;
      }
    }
    
    return null;
  };
  
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
          strategyType: 'static_replay',
          script: []
        }
      ]
    };
    
    config64 = encodeConfigToBase64URL(config);
    mcpBridge = new McpBridgeServer(orchestrator, 'test-scenario', config64, 'test-session');
  });
  
  afterEach(() => {
    // Close the database instance
    orchestrator.getDbInstance().close();
  });
  
  test('should list available MCP tools', async () => {
    const requestBody = {
      jsonrpc: '2.0',
      id: 'list-1',
      method: 'tools/list',
      params: {}
    };
    
    const response = await makeMcpRequest(requestBody);
    
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
    
    const response = await makeMcpRequest(request);
    
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
    
    const response = await makeMcpRequest(request);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('send-no-conv');
    // MCP SDK returns errors in result.isError, not error field
    expect(response.result).toBeDefined();
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('not found');
  });
  
  test('should handle wait_for_reply without pending reply', async () => {
    // First create a conversation
    const beginResponse = await makeMcpRequest({
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
    
    const response = await makeMcpRequest(waitRequest);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('wait-no-pending');
    // MCP SDK returns errors in result.isError, not error field
    expect(response.result).toBeDefined();
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('No pending reply');
  });
  
  test('should handle unknown method', async () => {
    const request = {
      jsonrpc: '2.0',
      id: 'unknown-1',
      method: 'unknown/method',
      params: {}
    };
    
    const response = await makeMcpRequest(request);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('unknown-1');
    expect(response.error).toBeDefined();
    // The MCP SDK transport uses -32601 for method not found
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toContain('Method not found');
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
    
    const response = await makeMcpRequest(request);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('unknown-tool');
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain('not found');
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
    
    // Use proper HTTP mocks
    const mockReq = new MockIncomingMessage('POST', {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream'
    }, request);
    
    const mockRes = new MockServerResponse();
    
    await invalidBridge.handleRequest(mockReq, mockRes, request);
    
    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Parse response
    const responseData = mockRes.getData();
    let response = null;
    if (responseData) {
      try {
        response = JSON.parse(responseData);
      } catch (e) {
        response = responseData;
      }
    }
    
    expect(response.jsonrpc).toBe('2.0');
    // MCP SDK returns errors in result.isError, not error field
    expect(response.result).toBeDefined();
    expect(response.result.isError).toBe(true);
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
    
    // Use proper HTTP mocks
    const mockReq = new MockIncomingMessage('POST', {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream'
    }, request);
    
    const mockRes = new MockServerResponse();
    
    await wrongBridge.handleRequest(mockReq, mockRes, request);
    
    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Parse response
    const responseData = mockRes.getData();
    let response = null;
    if (responseData) {
      try {
        response = JSON.parse(responseData);
      } catch (e) {
        response = responseData;
      }
    }
    
    expect(response.jsonrpc).toBe('2.0');
    // MCP SDK returns errors in result.isError, not error field
    expect(response.result).toBeDefined();
    expect(response.result.isError).toBe(true);
  });
  
  test('should handle send_message_to_chat_thread successfully', async () => {
    // First begin a chat thread
    const beginResponse = await makeMcpRequest({
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
    const response = await makeMcpRequest(sendRequest);
    
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('send-success');
    expect(response.result).toBeDefined();
    
    const result = JSON.parse(response.result.content[0].text);
    // Should get timeout since no other agent is responding
    expect(result.timeout).toBe(true);
  });
  
  test('should handle send_message with attachments', async () => {
    // First begin a chat thread
    const beginResponse = await makeMcpRequest({
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
    
    const response = await makeMcpRequest(sendRequest);
    
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
