#!/usr/bin/env bun
// Demo 2: Client-Side Agent Execution
//
// This demo shows running agents locally on the client side:
// 1. Connect to existing server on port 3000
// 2. Create a conversation (no 'kind' - location is runtime decision)
// 3. Use client ensure helper to run agents locally
// 4. Agents communicate with server via WebSocket JSON-RPC
// 5. Client manages the agent lifecycle and execution

import { ensureAgentsRunningClient } from '$src/agents/clients/ensure-client';
import { LLMProviderManager } from '$src/llm/provider-manager';

// Connect to existing server
const WS_URL = process.env.WS_URL || 'ws://localhost:3000/api/ws';
console.log(`🔌 Connecting to server at ${WS_URL}...`);

const ws = new WebSocket(WS_URL);
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
    // Track lastClosedSeq for the conversation
    let lastClosedSeq = 0;
    
    // Step 1: Create a conversation (no 'kind' property - location is runtime decision)
    console.log('\n📝 Creating conversation...');
    const { conversationId } = await sendRequest('createConversation', {
      meta: {
        title: 'Client-Side Demo',
        description: 'Agents run locally on the client',
        agents: [
          {
            id: 'user',
            displayName: 'User',
          },
          {
            id: 'local-assistant',
            displayName: 'Local Assistant',
            agentClass: 'AssistantAgent',
            config: { llmProvider: 'mock' }
          },
          {
            id: 'local-echo',
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
          // Track lastClosedSeq for our own messages
          if (e.finality !== 'none' && e.seq) {
            console.log(`  📌 Updating lastClosedSeq to ${e.seq}`);
            lastClosedSeq = e.seq;
          }
        }
      }
    });
    
    // Step 3: Ensure client-side agents are running
    console.log('\n🤖 Ensuring local agents are running...');
    const clientProvider = new LLMProviderManager({ 
      defaultLlmProvider: 'mock',
      googleApiKey: process.env.GOOGLE_API_KEY,
      openRouterApiKey: process.env.OPENROUTER_API_KEY
    });
    
    const { ensured, handles } = await ensureAgentsRunningClient({
      conversationId,
      agentIds: ['local-assistant', 'local-echo'],
      wsUrl: WS_URL,
      onGuidance: async ({ conversationId, agentId, sendMessage, getConversation }) => {
        // Simple mock response for demo
        const { lastClosedSeq } = await getConversation();
        await sendMessage({
          conversationId,
          agentId,
          text: `Agent ${agentId} responding from client! (seq: ${lastClosedSeq})`,
          finality: 'turn',
          clientRequestId: crypto.randomUUID()
        });
      }
    });
    
    console.log(`✅ Ensured ${ensured.length} local agents`);
    
    // Step 4: Send messages to trigger agent responses
    console.log('\n💬 Sending initial message...');
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'user',
      messagePayload: { text: 'Hello local agents! How are you running?' },
      finality: 'turn'
    });
    
    // Wait for local agents to respond
    console.log('\n⏳ Waiting for local agents to respond...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Send another message
    console.log(`\n💬 Sending follow-up message... (lastClosedSeq=${lastClosedSeq})`);
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'user',
      messagePayload: { text: 'Great to hear you are running locally!' },
      finality: 'turn'
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Step 5: Clean shutdown
    console.log('\n🛑 Stopping local agents...');
    for (const handle of Object.values(handles)) {
      handle.stop();
    }
    
    // End the conversation
    console.log(`\n🏁 Ending conversation... (lastClosedSeq=${lastClosedSeq})`);
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
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    ws.close();
    process.exit(1);
  }
};

ws.onerror = (error) => {
  console.error('❌ WebSocket error:', error);
  process.exit(1);
};