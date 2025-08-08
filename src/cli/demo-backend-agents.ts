#!/usr/bin/env bun
// Demo 3: Direct Backend Agent Execution
//
// This demo shows running agents directly in backend code:
// 1. Create an App instance with orchestrator
// 2. Create a conversation programmatically
// 3. Use InProcessTransport to run agents in-process
// 4. No WebSocket involved - all direct orchestrator calls
// 5. Useful for testing, batch processing, or embedded scenarios

import { App } from '$src/server/app';
import { startAgents } from '$src/agents/factories/agent.factory';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import type { UnifiedEvent } from '$src/types/event.types';

async function runDemo() {
  console.log('🎯 Demo 3: Direct Backend Agent Execution\n');
  
  // Create app with in-memory database
  const app = new App({ 
    dbPath: ':memory:', 
    nodeEnv: 'test',
    skipAutoRun: true // Don't auto-resume conversations
  });
  
  try {
    // Step 1: Create a conversation directly via orchestrator
    console.log('📝 Creating conversation directly via orchestrator...');
    const conversationId = app.orchestrator.createConversation({
      meta: {
        title: 'Backend Direct Demo',
        description: 'Agents run in-process without WebSocket',
        agents: [
          {
            id: 'system',
            kind: 'external',
            displayName: 'System'
          },
          {
            id: 'backend-agent-1',
            kind: 'internal',
            displayName: 'Backend Agent 1',
            agentClass: 'AssistantAgent',
            config: { llmProvider: 'mock' }
          },
          {
            id: 'backend-agent-2',
            kind: 'internal', 
            displayName: 'Backend Agent 2',
            agentClass: 'EchoAgent'
          }
        ]
      }
    });
    console.log(`✅ Created conversation ${conversationId}`);
    
    // Step 2: Subscribe directly to orchestrator events
    console.log('\n👀 Setting up direct event subscription...');
    const events: UnifiedEvent[] = [];
    const subId = app.orchestrator.subscribe(
      conversationId,
      (event: UnifiedEvent) => {
        events.push(event);
        if (event.type === 'message') {
          console.log(`📨 [${event.agentId}]: ${event.payload.text}`);
        } else if (event.type === 'trace') {
          console.log(`🔍 [${event.agentId}]: ${JSON.stringify(event.payload)}`);
        } else if (event.type === 'system') {
          console.log(`⚙️ [System]: ${JSON.stringify(event.payload)}`);
        }
      },
      true // Include guidance
    );
    
    // Step 3: Start agents using InProcessTransport
    console.log('\n🤖 Starting backend agents with InProcessTransport...');
    const agentHandle = await startAgents({
      conversationId,
      transport: new InProcessTransport(app.orchestrator),
      providerManager: app.llmProviderManager
    });
    console.log(`✅ Started ${agentHandle.agents.length} backend agents`);
    
    // Step 4: Send messages directly via orchestrator
    console.log('\n💬 Sending initial message via orchestrator...');
    app.orchestrator.sendMessage(
      conversationId,
      'system',
      { text: 'Hello backend agents! Please report your status.' },
      'turn'
    );
    
    // Wait for agents to respond
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Send another message
    console.log('\n💬 Sending follow-up message...');
    app.orchestrator.sendMessage(
      conversationId,
      'system',
      { text: 'Excellent work, backend agents!' },
      'turn'
    );
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Step 5: Demonstrate attachment handling
    console.log('\n📎 Sending message with attachment...');
    app.orchestrator.sendMessage(
      conversationId,
      'system',
      { 
        text: 'Here is some data for you to process.',
        attachments: [{
          name: 'data.json',
          contentType: 'application/json',
          content: JSON.stringify({ key: 'value', timestamp: Date.now() }),
          summary: 'Sample JSON data'
        }]
      },
      'turn'
    );
    
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Step 6: End the conversation
    console.log('\n🏁 Ending conversation...');
    app.orchestrator.sendMessage(
      conversationId,
      'system',
      { text: 'Backend demo complete. Shutting down.' },
      'conversation'
    );
    
    // Wait a moment for final processing
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Step 7: Retrieve and display summary
    console.log('\n📊 Conversation Summary:');
    const snapshot = app.orchestrator.getConversationSnapshot(conversationId);
    console.log(`  - Status: ${snapshot.status}`);
    console.log(`  - Total events: ${snapshot.events.length}`);
    console.log(`  - Message count: ${snapshot.events.filter(e => e.type === 'message').length}`);
    console.log(`  - Trace count: ${snapshot.events.filter(e => e.type === 'trace').length}`);
    
    // Check attachments
    const attachments = app.orchestrator.storage.attachments.listByConversation(conversationId);
    console.log(`  - Attachments: ${attachments.length}`);
    
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    app.orchestrator.unsubscribe(subId);
    await agentHandle.stop();
    await app.shutdown();
    
    console.log('\n✅ Demo complete! All agents ran in-process without WebSocket.');
    
  } catch (error) {
    console.error('❌ Error:', error);
    await app.shutdown();
    process.exit(1);
  }
}

// Run the demo
runDemo().catch(console.error);