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
    hono.route('/api/bridge', createBridgeRoutes(app.orchestrator, app.llmProviderManager, app.lifecycleManager, 200)); // short timeout
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

    const res = await fetch(`${baseUrl}/api/bridge/${config64}/mcp/diag`);
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

    const res = await fetch(`${baseUrl}/api/bridge/${config64}/mcp`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json', 
        'accept': 'application/json, text/event-stream' 
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'begin_chat_thread', arguments: {} } }),
    });

    expect(res.status).toBe(200);
    const text1 = await res.text();
    const json = JSON.parse(text1);
    expect(json.jsonrpc).toBe('2.0');
    const contentText = json.result?.content?.[0]?.text ?? json.content?.[0]?.text;
    expect(typeof contentText).toBe('string');
    const result = JSON.parse(contentText);
    expect(typeof result.conversationId).toBe('string');
    // nextSeq removed from begin response; only conversationId is returned
    // The conversation ID should be a numeric string
    expect(Number(result.conversationId)).toBeGreaterThan(0);
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

    const res = await fetch(`${baseUrl}/api/bridge/${config64}/mcp`, {
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
    expect(typeof result.conversationId).toBe('string');
    // nextSeq removed from begin response
    expect(Number(result.conversationId)).toBeGreaterThan(0);
  });

  it('send_message_to_chat_thread and check_replies return simplified messages', async () => {
    const configMeta = {
      title: 'Echo Test',
      startingAgentId: 'user',
      agents: [
        { id: 'user', kind: 'external' },
        { id: 'echo', kind: 'internal', agentClass: 'EchoAgent' },
      ],
    };
    const config64 = toBase64Url(configMeta);

    // Begin
    const beginRes = await fetch(`${baseUrl}/api/bridge/${config64}/mcp`, {
      method: 'POST',
      headers: { 
        'content-type': 'application/json', 
        'accept': 'application/json, text/event-stream' 
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'begin_chat_thread', arguments: {} } }),
    });
    const beginJson = await beginRes.json();
    const begin = JSON.parse(beginJson.result.content[0].text);

    // Send (with an attachment)
    const sendRes = await fetch(`${baseUrl}/api/bridge/${config64}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 's', method: 'tools/call', params: { name: 'send_message_to_chat_thread', arguments: { conversationId: begin.conversationId, message: 'hello', attachments: [{ name: 'note.txt', contentType: 'text/plain', content: 'hello doc' }] } } })
    });
    const sendJson = await sendRes.json();
    if (sendJson.error) throw new Error(`send_message_to_chat_thread error: ${JSON.stringify(sendJson.error)}`);
    const send = JSON.parse(sendJson.result.content[0].text);
    expect(send.ok).toBe(true);

    // Long-poll for replies since the last external message
    const updRes = await fetch(`${baseUrl}/api/bridge/${config64}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'u', method: 'tools/call', params: { name: 'check_replies', arguments: { conversationId: begin.conversationId, waitMs: 2000 } } })
    });
    const updJson = await updRes.json();
    if (updJson.error) throw new Error(`check_replies error: ${JSON.stringify(updJson.error)}`);
    const upd = JSON.parse(updJson.result.content[0].text);
    expect(Array.isArray(upd.messages)).toBe(true);
    // Simplified messages omit attachment content; ensure structure exists
    if (upd.messages.length > 0) {
      const m = upd.messages[0];
      expect(typeof m.from).toBe('string');
      expect(typeof m.at).toBe('string');
      expect(typeof m.text).toBe('string');
      if (Array.isArray(m.attachments) && m.attachments.length > 0) {
        expect(typeof m.attachments[0].name).toBe('string');
        expect(typeof m.attachments[0].contentType).toBe('string');
      }
      expect(['input-required','waiting']).toContain(upd.status);
      expect(typeof upd.guidance).toBe('string');
      expect(typeof upd.conversation_ended).toBe('boolean');
    }
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
