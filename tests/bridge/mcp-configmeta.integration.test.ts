// tests/bridge/mcp-configmeta.integration.test.ts (skeleton)
//
// Integration test using base64url ConversationMeta as config format.
//

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { App } from '$src/server/app';
import { createBridgeRoutes } from '$src/server/routes/bridge.mcp';
import { websocket } from '$src/server/ws/jsonrpc.server';

describe('MCP Bridge with ConversationMeta config (Phase 2)', () => {
  let app: App;
  let server: any;
  let baseUrl: string;

  beforeAll(() => {
    app = new App({ dbPath: ':memory:' });
    const hono = new Hono();
    hono.route('/bridge', createBridgeRoutes(app.orchestrator, app.providerManager, 200)); // short timeout
    server = Bun.serve({ port: 0, fetch: hono.fetch, websocket });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop();
    await app.shutdown();
  });

  it('diagnostic endpoint returns parsed meta', async () => {
    const configMeta = {
      title: 'Test Conversation',
      agents: [
        { id: 'agent-a', kind: 'external' },
        { id: 'agent-b', kind: 'internal', agentClass: 'EchoAgent' },
      ],
    };
    const config64 = toBase64Url(configMeta);

    const res = await fetch(`${baseUrl}/bridge/${config64}/mcp/diag`);
    expect(res.status).toBe(200);
    
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.meta.title).toBe('Test Conversation');
    expect(json.meta.agents).toHaveLength(2);
  });

  it('supports different agent types', async () => {
    const configMeta = {
      title: 'Multi-Agent Test',
      agents: [
        { id: 'user', kind: 'external' },
        { id: 'echo', kind: 'internal', agentClass: 'EchoAgent' },
        { id: 'assistant', kind: 'internal', agentClass: 'AssistantAgent' },
      ],
    };
    const config64 = toBase64Url(configMeta);

    const res = await fetch(`${baseUrl}/bridge/${config64}/mcp`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json', 
        'accept': 'application/json, text/event-stream' 
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'begin_chat_thread', arguments: {} } }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jsonrpc).toBe('2.0');
    
    const result = JSON.parse(json.result.content[0].text);
    expect(typeof result.conversationId).toBe('number');
    
    // The conversation ID should be a valid number
    expect(result.conversationId).toBeGreaterThan(0);
    // The agents are started internally, which we can verify by the logs showing "START INTERNAL" for echo and assistant
  });

  it('begin_chat_thread creates a conversation from meta', async () => {
    const configMeta = {
      title: 'Bridge Conversation',
      description: 'Demo',
      scenarioId: 'test-scenario-xyz', // assume scenario inserted elsewhere in a full test
      startingAgentId: 'external-a',
      agents: [
        { id: 'external-a', kind: 'external', role: 'user', displayName: 'External Client' },
        { id: 'internal-b', kind: 'internal', agentClass: 'ScenarioDrivenAgent', role: 'assistant' },
      ],
    };
    const config64 = toBase64Url(configMeta);

    const res = await fetch(`${baseUrl}/bridge/${config64}/mcp`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json', 
        'accept': 'application/json, text/event-stream' 
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'begin_chat_thread', arguments: {} } }),
    });

    expect(res.status).toBe(200);
    
    const text = await res.text();
    const json = JSON.parse(text);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe('1');
    
    if (json.error) {
      console.error('JSON-RPC error:', json.error);
      throw new Error(json.error.message);
    }
    
    const result = JSON.parse(json.result.content[0].text);
    expect(typeof result.conversationId).toBe('number');
  });
});

function toBase64Url(obj: any): string {
  const str = JSON.stringify(obj);
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}