#!/usr/bin/env bun
// Demo: Client-Side Orchestration
//
// This demo shows running the conversation orchestration from the client side:
// 1. Create a conversation with all external agents
// 2. Client manages ALL agents locally using WsTransport
// 3. Client coordinates turn-taking and conversation flow
// 4. Server only stores events and provides coordination primitives
// 5. This is essentially "runConversationToCompletion" but client-side

// import { Bun } from 'bun'; // Bun is a global, not an import
import { App } from '$src/server/app';
import { createWebSocketServer } from '$src/server/ws/jsonrpc.server';
import { startAgents } from '$src/agents/factories/agent.factory';
import { WsTransport } from '$src/agents/runtime/ws.transport';
import { LLMProviderManager } from '$src/llm/provider-manager';

// Start the server
const app = new App({ dbPath: ':memory:', nodeEnv: 'test' });
const { websocket } = await import('$src/server/ws/jsonrpc.server');
const wsServer = createWebSocketServer(app.orchestrator, app.llmProviderManager);
const server = Bun.serve({
  port: 3459,
  fetch: wsServer.fetch,
  websocket,
});

console.log(`🚀 Server running on ws://localhost:${server.port}/api/ws`);

// Create WebSocket client for control
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

// Client-side "runConversationToCompletion" implementation
async function runConversationToCompletionClientSide(
  conversationId: number,
  wsUrl: string,
  providerManager: LLMProviderManager
) {
  console.log('\n🎮 Client taking control of conversation orchestration...');
  
  // Start ALL agents on the client side
  const agentHandle = await startAgents({
    conversationId,
    transport: new WsTransport(wsUrl),
    providerManager
    // No agentIds filter - we want ALL agents
  });
  
  console.log(`  ✓ Client managing ${agentHandle.agents.length} agents locally`);
  console.log('  ✓ Agents will coordinate via WebSocket');
  console.log('  ✓ Server provides event storage and guidance only\n');
  
  return agentHandle;
}

ws.onopen = async () => {
  console.log('✅ Connected to server\n');
  
  try {
    // Step 1: Create conversation with all external agents
    console.log('📝 Creating conversation (all agents client-managed)...');
    const { conversationId } = await sendRequest('createConversation', {
      meta: {
        title: 'Client-Side Orchestration Demo',
        description: 'Client runs "conversationToCompletion" locally',
        agents: [
          {
            id: 'alice',
            displayName: 'Alice',
            agentClass: 'AssistantAgent',
            config: { llmProvider: 'mock' }
          },
          {
            id: 'bob',
            displayName: 'Bob',
            agentClass: 'AssistantAgent',
            config: { llmProvider: 'mock' }
          },
          {
            id: 'charlie',
            displayName: 'Charlie',
            agentClass: 'EchoAgent'
          },
          {
            id: 'user',
            displayName: 'User'
          }
        ]
      }
    });
    console.log(`✅ Created conversation ${conversationId}`);
    
    // Step 2: Subscribe to monitor events
    console.log('\n👀 Setting up event monitoring...');
    const { subId } = await sendRequest('subscribe', {
      conversationId,
      includeGuidance: true
    });
    
    let eventCount = 0;
    let lastSpeaker = '';
    
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'event') {
        const e = data.params;
        if (e.type === 'message') {
          eventCount++;
          lastSpeaker = e.agentId;
          console.log(`📱 [CLIENT-MANAGED] ${e.agentId}: ${e.payload.text}`);
          
          // Check for conversation end
          if (e.finality === 'conversation') {
            console.log('\n🏁 Conversation ended by ' + e.agentId);
          }
        }
      } else if (data.method === 'guidance') {
        console.log(`🎯 Guidance: ${data.params.nextAgentId} should speak next`);
      }
    });
    
    // Step 3: Run conversation to completion FROM THE CLIENT
    const clientProvider = new LLMProviderManager({ 
      defaultLlmProvider: 'mock',
      googleApiKey: process.env.GOOGLE_API_KEY,
      openRouterApiKey: process.env.OPENROUTER_API_KEY
    });
    const wsUrl = `ws://localhost:${server.port}/api/ws`;
    
    const agentHandle = await runConversationToCompletionClientSide(
      conversationId,
      wsUrl,
      clientProvider
    );
    
    // Step 4: Kick off the conversation
    console.log('💬 Starting conversation...\n');
    console.log('─'.repeat(60));
    
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'user',
      messagePayload: { 
        text: 'Hello everyone! Let\'s have a discussion. Alice, what do you think about running agents on the client side?'
      },
      finality: 'turn'
    });
    
    // Let agents respond autonomously
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // User continues
    console.log('\n💬 User continuing conversation...\n');
    console.log('─'.repeat(60));
    
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'user',
      messagePayload: { 
        text: 'Bob and Charlie, what are your thoughts on this architecture?'
      },
      finality: 'turn'
    });
    
    // More autonomous responses
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // User ends conversation
    console.log('\n💬 User ending conversation...\n');
    console.log('─'.repeat(60));
    
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'user',
      messagePayload: { 
        text: 'Thank you all for the discussion. This demonstrates client-side orchestration perfectly!'
      },
      finality: 'conversation'
    });
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('📊 Client-Side Orchestration Summary:');
    console.log(`  • Total events processed: ${eventCount}`);
    console.log(`  • All ${agentHandle.agents.length} agents ran on CLIENT`);
    console.log('  • Server only provided:');
    console.log('    - Event storage (append-only log)');
    console.log('    - Guidance events (scheduling hints)');
    console.log('    - Turn claims (coordination primitive)');
    console.log('  • Client handled:');
    console.log('    - Agent instantiation and lifecycle');
    console.log('    - Turn-taking logic via guidance');
    console.log('    - Message generation and responses');
    console.log('═'.repeat(60));
    
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await agentHandle.stop();
    await sendRequest('unsubscribe', { subId });
    ws.close();
    server.stop();
    await app.shutdown();
    
    console.log('✅ Demo complete! Client successfully orchestrated the entire conversation.');
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