import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { ConversationOrchestrator } from '../core/orchestrator.js';
import { createBridgeRoutes } from './bridge.js';
import { encodeConfigToBase64URL } from '$lib/utils/config-encoding.js';
import { CreateConversationRequest } from '$lib/types.js';
import { seedDatabase } from '../db/seed.js';
import { ConversationDatabase } from '../db/database.js';
import { createLLMProvider } from '$llm/factory.js';

describe('Bridge API Integration', () => {
  let app: Hono;
  let orchestrator: ConversationOrchestrator;
  
  beforeEach(async () => {
    // Create a Google LLM provider with dummy key for testing
    const mockLLMProvider = createLLMProvider({
      provider: 'google',
      model: 'gemini-2.5-flash-lite',
      apiKey: 'test-api-key'
    });
    
    // Pass memory database path to orchestrator
    orchestrator = new ConversationOrchestrator(':memory:', mockLLMProvider);
    
    // Seed the database through orchestrator's DB instance
    await seedDatabase(orchestrator.getDbInstance());
    
    app = new Hono();
    app.route('/bridge', createBridgeRoutes(orchestrator));
  });
  
  afterEach(async () => {
    // Close the DB through orchestrator
    orchestrator.getDbInstance().close();
  });
  
  test('should handle MCP tools/list request', async () => {
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'scen_knee_mri_01',
        conversationTitle: 'Test MCP'
      },
      agents: [
        {
          id: 'patient-agent',
          strategyType: 'bridge_to_external_mcp_server',
          shouldInitiateConversation: true
        },
        {
          id: 'insurance-auth-specialist',
          strategyType: 'scenario_driven'
        }
      ]
    };
    
    const config64 = encodeConfigToBase64URL(config);
    
    const response = await app.request(`/bridge/${config64}/mcp`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '123',
        method: 'tools/list',
        params: {}
      }),
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe('123');
    expect(data.result?.tools).toHaveLength(3);
    expect(data.result?.tools[0].name).toBe('begin_chat_thread');
  });
  
  test('should handle begin_chat_thread tool call', async () => {
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'scen_knee_mri_01',
        conversationTitle: 'Test MCP'
      },
      agents: [
        {
          id: 'patient-agent',
          strategyType: 'bridge_to_external_mcp_server',
          shouldInitiateConversation: true
        },
        {
          id: 'insurance-auth-specialist',
          strategyType: 'scenario_driven'
        }
      ]
    };
    
    const config64 = encodeConfigToBase64URL(config);
    
    const response = await app.request(`/bridge/${config64}/mcp`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '456',
        method: 'tools/call',
        params: {
          name: 'begin_chat_thread',
          arguments: {}
        }
      }),
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe('456');
    expect(data.result?.content[0]?.type).toBe('text');
    
    const result = JSON.parse(data.result.content[0].text);
    expect(result.conversationId).toBeDefined();
    expect(result.conversationId).toBeTruthy(); // UUID format, not conv_ prefix
  });
  
  test('should return error for invalid tool', async () => {
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'scen_knee_mri_01'
      },
      agents: [
        {
          id: 'test-agent',
          strategyType: 'bridge_to_external_mcp_server'
        }
      ]
    };
    
    const config64 = encodeConfigToBase64URL(config);
    
    const response = await app.request(`/bridge/${config64}/mcp`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '789',
        method: 'tools/call',
        params: {
          name: 'invalid_tool',
          arguments: {}
        }
      }),
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe('789');
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(-32603);
    expect(data.error.message).toContain('Unknown tool: invalid_tool');
  });
});