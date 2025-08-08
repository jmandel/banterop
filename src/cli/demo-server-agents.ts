#!/usr/bin/env bun
// Demo 1: Server-Side Agent Execution
// 
// This demo connects to an existing server and triggers backend agents:
// 1. Connect to existing server on port 3000
// 2. Create a conversation with agents marked as kind: 'internal'
// 3. Send runConversationToCompletion to trigger backend execution
// 4. Subscribe to events to monitor progress
// 5. The agents run entirely on the server using InProcessTransport

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
    const refreshLastClosedSeq = async (conversationId: number) => {
      try {
        const snap = await sendRequest('getConversationSnapshot', { conversationId });
        if (typeof snap?.lastClosedSeq === 'number') {
          lastClosedSeq = snap.lastClosedSeq;
        }
      } catch (e) {
        // Non-fatal: keep prior lastClosedSeq
      }
    };
    
    // Step 1: Create a conversation with internal agents
    console.log('\n📝 Creating conversation with internal agents...');
    const { conversationId } = await sendRequest('createConversation', {
      meta: {
        title: 'Server-Side Demo',
        description: 'All agents run on the backend',
        agents: [
          {
            id: 'user',
            kind: 'external',
            displayName: 'User',
          },
          {
            id: 'assistant-1',
            kind: 'internal',
            displayName: 'Assistant 1',
            agentClass: 'AssistantAgent',
            config: { llmProvider: 'mock' }
          },
          {
            id: 'assistant-2', 
            kind: 'internal',
            displayName: 'Assistant 2',
            agentClass: 'EchoAgent'
          }
        ]
      }
    });
    console.log(`✅ Created conversation ${conversationId}`);
    
    // Step 2: Subscribe to events to monitor
    console.log('\n👀 Subscribing to conversation events...');
    const { subId } = await sendRequest('subscribe', {
      conversationId,
      includeGuidance: true
    });
    
    // Set up event listener
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'event') {
        const e = data.params;
        if (e.type === 'message') {
          console.log(`📨 [${e.agentId}]: ${e.payload.text}`);
          // Update lastClosedSeq when we see a message that closes a turn
          if (e.finality !== 'none' && e.seq) {
            console.log(`  📌 Updating lastClosedSeq from ${lastClosedSeq} to ${e.seq}`);
            lastClosedSeq = e.seq;
          }
        } else if (e.type === 'trace') {
          console.log(`🔍 [${e.agentId}]: ${JSON.stringify(e.payload)}`);
        }
      } else if (data.method === 'guidance') {
        console.log(`🎯 Guidance: Next agent = ${data.params.nextAgentId}`);
      }
    });
    
    // Step 3: Trigger backend execution
    console.log('\n🎬 Starting backend agent execution...');
    await sendRequest('runConversationToCompletion', { conversationId });
    
    // Step 4: Send an initial message as the user
    console.log('\n💬 Sending initial message...');
    const msg1Result = await sendRequest('sendMessage', {
      conversationId,
      agentId: 'user',
      messagePayload: { text: 'Hello agents! Please introduce yourselves.' },
      finality: 'turn'
    });
    // We can also track seq from the result if needed
    
    // Let it run for a bit to see the agents respond
    console.log('\n⏳ Waiting for agents to respond...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    // Ensure we have the authoritative lastClosedSeq before next turn
    await refreshLastClosedSeq(conversationId);
    
    // Send another message
    console.log(`\n💬 Sending follow-up message... (lastClosedSeq=${lastClosedSeq})`);
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'user',
      messagePayload: { text: 'Thank you both! Goodbye.' },
      finality: 'turn'
    });
    
    // Wait a bit more
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // End the conversation
    console.log('\n🏁 Ending conversation...');
    // Refresh again before closing the conversation
    await refreshLastClosedSeq(conversationId);
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'user',
      messagePayload: { text: 'End of demo.' },
      finality: 'conversation'
    });
    
    console.log('\n✅ Demo complete! Agents ran entirely on the server.');
    
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
