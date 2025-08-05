import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { createBridgeRoutes } from './bridge.js';
import { ConversationOrchestrator } from '../core/orchestrator.js';
import { encodeConfigToBase64URL } from '$lib/utils/config-encoding.js';
import { CreateConversationRequest } from '$lib/types.js';
import { Database } from 'bun:sqlite';

describe('Bridge API Routes', () => {
  let app: Hono;
  let orchestrator: ConversationOrchestrator;
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

    // Create app with bridge routes
    app = new Hono();
    app.route('/bridge', createBridgeRoutes(orchestrator));
  });

  afterEach(() => {
    db.close();
  });

  it('should handle MCP endpoint with unknown method', async () => {
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'test-scenario',
        conversationTitle: 'Test Bridge'
      },
      agents: [
        {
          id: 'mcp-agent',
          strategyType: 'bridge_to_external_mcp_server',
          shouldInitiateConversation: true
        },
        {
          id: 'internal-agent',
          strategyType: 'scenario_driven'
        }
      ]
    };

    const config64 = encodeConfigToBase64URL(config);
    
    const res = await app.request(`/bridge/${config64}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'unknown_method',
        params: {},
        id: 1
      })
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(1);
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32601);
    expect(json.error.message).toBeDefined();
  });

  it('should handle diagnostics endpoint', async () => {
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'test-scenario',
        conversationTitle: 'Test Bridge'
      },
      agents: [
        {
          id: 'agent-1',
          strategyType: 'scenario_driven'
        }
      ]
    };

    const config64 = encodeConfigToBase64URL(config);
    
    const res = await app.request(`/bridge/${config64}/mcp/diag`, {
      method: 'GET'
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.scenarioId).toBe('test-scenario');
    expect(json.configValid).toBe(true);
    expect(json.config.agentCount).toBe(1);
  });

  it('should handle invalid config64', async () => {
    const res = await app.request('/bridge/invalid-base64/mcp/diag', {
      method: 'GET'
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeDefined();
  });
});