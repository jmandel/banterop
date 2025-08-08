#!/usr/bin/env bun
// Demo 6: Resume Existing Conversation
//
// This demo shows how to resume an existing conversation:
// 1. Connect to existing server
// 2. List active conversations
// 3. Select a conversation to resume
// 4. Get conversation state and continue from where it left off
// 5. Demonstrates stateful conversation management

import * as readline from 'readline';

// Connect to existing server
const WS_URL = process.env.WS_URL || 'ws://localhost:3000/api/ws';
const API_URL = process.env.API_URL || 'http://localhost:3000/api';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const prompt = (question: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
};

console.log('🔄 Resume Conversation Demo\n');
console.log('This demo lets you resume and continue existing conversations.\n');

(async () => {
  try {
    // Since there's no REST endpoint for listing conversations,
    // we'll ask the user to provide a conversation ID
    console.log('📋 Resume a conversation by ID\n');
    console.log('Recent conversation IDs from previous demos:');
    console.log('  - Use the conversation ID from your last demo run');
    console.log('  - Or check server logs for recent conversation IDs\n');
    
    const conversationIdStr = await prompt('Enter conversation ID to resume: ');
    const conversationId = parseInt(conversationIdStr);
    
    if (!conversationId || isNaN(conversationId)) {
      console.log('Invalid conversation ID.');
      process.exit(1);
    }
    
    console.log(`\n✅ Selected conversation ${conversationId}\n`);
    
    // Step 2: Connect to WebSocket and get conversation state
    console.log(`🔌 Connecting to server at ${WS_URL}...`);
    const ws = new WebSocket(WS_URL);
    let reqId = 1;
    let lastClosedSeq = 0;
    
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
    
    await new Promise((resolve) => {
      ws.onopen = resolve;
      ws.onerror = (err) => {
        console.error('❌ Failed to connect:', err);
        process.exit(1);
      };
    });
    
    console.log('✅ Connected to server\n');
    
    // Get conversation snapshot
    console.log('📊 Loading conversation state...');
    const snapshot = await sendRequest('getConversation', { conversationId });
    
    // Update lastClosedSeq from snapshot
    lastClosedSeq = snapshot.lastClosedSeq || 0;
    
    console.log(`  Status: ${snapshot.status}`);
    console.log(`  Events: ${snapshot.events.length}`);
    console.log(`  Last closed turn seq: ${lastClosedSeq}`);
    
    // Show recent history
    console.log('\n📜 Recent messages:');
    const recentMessages = snapshot.events
      .filter((e: any) => e.type === 'message')
      .slice(-5);
    
    recentMessages.forEach((msg: any) => {
      console.log(`  [${msg.agentId}]: ${msg.payload.text.substring(0, 80)}${msg.payload.text.length > 80 ? '...' : ''}`);
    });
    
    if (snapshot.status === 'completed') {
      console.log('\n⚠️  This conversation is already completed.');
      console.log('You can view the history but cannot add new messages.');
      ws.close();
      rl.close();
      process.exit(0);
    }
    
    // Step 4: Subscribe to events
    console.log('\n👀 Subscribing to conversation events...');
    const { subId } = await sendRequest('subscribe', {
      conversationId,
      includeGuidance: true
    });
    
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'event') {
        const e = data.params;
        if (e.type === 'message') {
          if (e.agentId !== 'resume-user') {
            console.log(`\n[${e.agentId}]: ${e.payload.text}`);
          }
          // Update lastClosedSeq when a turn closes
          if (e.finality !== 'none' && e.seq) {
            lastClosedSeq = e.seq;
          }
        }
      } else if (data.method === 'guidance') {
        const nextAgent = data.params.nextAgentId;
        if (nextAgent && nextAgent !== 'resume-user') {
          console.log(`  → Next: ${nextAgent}`);
        }
      }
    });
    
    // Step 5: Check if agents need to be restarted
    const metadata = snapshot.metadata || {};
    const hasInternalAgents = metadata.agents?.some((a: any) => a.kind === 'internal');
    
    if (hasInternalAgents) {
      console.log('\n🤖 Restarting server-side agents...');
      try {
        await sendRequest('runConversationToCompletion', { conversationId });
        console.log('✅ Agents restarted and ready to continue!\n');
      } catch (error) {
        console.log('⚠️  Could not restart agents (they may already be running)\n');
      }
    }
    
    // Step 6: Interactive continuation
    console.log('💬 Continue the conversation! Type your messages below.');
    console.log('   (Type "exit" to leave, "end" to complete the conversation)\n');
    console.log('─'.repeat(60));
    
    // Determine which agent ID to use for sending messages
    const userAgent = metadata.agents?.find((a: any) => 
      a.id.includes('user') || a.id.includes('coordinator') || a.kind === 'external'
    );
    const agentId = userAgent?.id || 'resume-user';
    
    while (true) {
      const message = await prompt(`\nYou (as ${agentId}): `);
      
      if (message.toLowerCase() === 'exit') {
        console.log('\n👋 Leaving conversation (still active)...');
        break;
      }
      
      if (message.toLowerCase() === 'end') {
        console.log('\n🏁 Completing conversation...');
        await sendRequest('sendMessage', {
          conversationId,
          agentId,
          messagePayload: { text: 'Conversation completed. Thank you!' },
          finality: 'conversation',
          precondition: { lastClosedSeq }
        });
        break;
      }
      
      // Send message
      await sendRequest('sendMessage', {
        conversationId,
        agentId,
        messagePayload: { text: message },
        finality: 'turn',
        precondition: { lastClosedSeq }
      });
      
      // Wait for responses
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await sendRequest('unsubscribe', { subId });
    ws.close();
    rl.close();
    
    console.log('✅ Demo complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ Error:', error);
    rl.close();
    process.exit(1);
  }
})();