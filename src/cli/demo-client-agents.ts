#!/usr/bin/env bun
// Demo 2: Client-Side Agent Execution
//
// This demo shows running agents locally on the client side:
// 1. Connect to the server over WebSocket
// 2. Create a conversation (agents marked as external)
// 3. Use WsTransport to run agents locally on the client
// 4. Agents communicate with server via WebSocket JSON-RPC
// 5. Client manages the agent lifecycle and execution

import { Bun } from 'bun';
import { App } from '$src/server/app';
import { createWebSocketServer } from '$src/server/ws/jsonrpc.server';
import { startAgents } from '$src/agents/factories/agent.factory';
import { WsTransport } from '$src/agents/runtime/ws.transport';
import { ProviderManager } from '$src/llm/provider-manager';

// Start the server with in-memory DB
const app = new App({ dbPath: ':memory:', nodeEnv: 'test' });
const wsServer = createWebSocketServer(app.orchestrator, app.providerManager);
const server = Bun.serve({
  port: 3457,
  fetch: wsServer.fetch,
  websocket: wsServer.websocket,
});

console.log(`🚀 Server running on ws://localhost:${server.port}/api/ws`);

// Connect as a client to create the conversation
const ws = new WebSocket(`ws://localhost:${server.port}/api/ws`);
let reqId = 1;

function sendRequest(method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = reqId++;
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.id === id) {
        ws.removeEventListener('message', handler);
        if (data.error) {
          reject(new Error(data.error.message));
        } else {
          resolve(data.result);
        }
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

ws.onopen = async () => {
  console.log('✅ Connected to server');
  
  try {
    // Step 1: Create a conversation with external agents
    console.log('\n📝 Creating conversation with external agents...');
    const { conversationId } = await sendRequest('createConversation', {
      meta: {
        title: 'Client-Side Demo',
        description: 'Agents run locally on the client',
        agents: [
          {
            id: 'user',
            kind: 'external',
            displayName: 'User',
          },
          {
            id: 'local-assistant',
            kind: 'external', // External = client-managed
            displayName: 'Local Assistant',
            agentClass: 'AssistantAgent',
            config: { llmProvider: 'mock' }
          },
          {
            id: 'local-echo',
            kind: 'external',
            displayName: 'Local Echo',
            agentClass: 'EchoAgent'
          }
        ]
      }
    });
    console.log(`✅ Created conversation ${conversationId}`);
    
    // Step 2: Subscribe to monitor events (from our perspective)
    console.log('\n👀 Setting up event monitoring...');
    const { subId } = await sendRequest('subscribe', {
      conversationId,
      includeGuidance: false // We'll handle guidance in our agents
    });
    
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'event') {
        const e = data.params;
        if (e.type === 'message') {
          console.log(`📨 [Server view - ${e.agentId}]: ${e.payload.text}`);
        }
      }
    });
    
    // Step 3: Start client-side agents using WsTransport
    console.log('\n🤖 Starting local agents with WsTransport...');
    const clientProvider = new ProviderManager({ defaultLlmProvider: 'mock' });
    const wsUrl = `ws://localhost:${server.port}/api/ws`;
    
    const agentHandle = await startAgents({
      conversationId,
      transport: new WsTransport(wsUrl),
      providerManager: clientProvider,
      agentIds: ['local-assistant', 'local-echo'] // Only our local agents
    });
    
    console.log(`✅ Started ${agentHandle.agents.length} local agents`);
    
    // Step 4: Send messages to trigger agent responses
    console.log('\n💬 Sending initial message...');
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'user',
      messagePayload: { text: 'Hello local agents! How are you running?' },
      finality: 'turn'
    });
    
    // Wait for local agents to respond
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Send another message
    console.log('\n💬 Sending follow-up message...');
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'user',
      messagePayload: { text: 'Great to hear you are running locally!' },
      finality: 'turn'
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Step 5: Clean shutdown
    console.log('\n🛑 Stopping local agents...');
    await agentHandle.stop();
    
    // End the conversation
    console.log('\n🏁 Ending conversation...');
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'user',
      messagePayload: { text: 'Demo complete - agents ran on the client!' },
      finality: 'conversation'
    });
    
    console.log('\n✅ Demo complete! Agents ran entirely on the client using WsTransport.');
    
    // Cleanup
    await sendRequest('unsubscribe', { subId });
    ws.close();
    server.stop();
    await app.shutdown();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    ws.close();
    server.stop();
    await app.shutdown();
    process.exit(1);
  }
};

ws.onerror = (error) => {
  console.error('❌ WebSocket error:', error);
  process.exit(1);
};