#!/usr/bin/env bun
import { App } from './src/server/app';
import { InternalTurnLoop } from './src/agents/executors/internal-turn-loop';
import { EchoAgent } from './src/agents/echo.agent';
import type { UnifiedEvent } from './src/types/event.types';

async function testTurnLoop() {
  console.log('Testing new turn-loop executor...\n');
  
  const app = new App({ 
    dbPath: ':memory:', 
    emitGuidance: true,
    emitNextCandidates: false  // Disable legacy worker spawning
  });
  
  const orch = app.orchestrator;
  const conversationId = orch.createConversation({ title: 'Turn Loop Test' });
  
  // Subscribe to see what's happening
  orch.subscribe(
    conversationId,
    (e: UnifiedEvent) => {
      if (e.type === 'message') {
        console.log(`[EVENT] ${e.agentId}: "${(e.payload as any).text}" (${e.finality})`);
      } else if (e.type === 'system') {
        console.log(`[SYSTEM] ${(e.payload as any).kind}`);
      }
    },
    false  // Don't need guidance in this subscription
  );
  
  // Create internal agents using new turn loop
  const agentA = new InternalTurnLoop(
    new EchoAgent('Agent A thinking...', 'Agent A says hello!'),
    orch,
    { conversationId, agentId: 'agent-a' }
  );
  
  const agentB = new InternalTurnLoop(
    new EchoAgent('Agent B processing...', 'Agent B responds!'),
    orch,
    { conversationId, agentId: 'agent-b' }
  );
  
  // Start both agents (they'll wait for guidance)
  const agentATask = agentA.start();
  const agentBTask = agentB.start();
  
  // Give them time to subscribe
  await new Promise(resolve => setTimeout(resolve, 100));
  
  console.log('User starts conversation...\n');
  
  // User message triggers guidance for agent-a (per SimpleAlternationPolicy)
  orch.appendEvent({
    conversation: conversationId,
    type: 'message',
    payload: { text: 'Hello agents!' },
    finality: 'turn',
    agentId: 'user',
  });
  
  // Wait a bit for agents to process
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // User ends conversation
  console.log('\nUser ends conversation...');
  orch.appendEvent({
    conversation: conversationId,
    type: 'message',
    payload: { text: 'Goodbye!' },
    finality: 'conversation',
    agentId: 'user',
  });
  
  // Wait for agents to stop
  await Promise.race([
    Promise.all([agentATask, agentBTask]),
    new Promise(resolve => setTimeout(resolve, 1000))
  ]);
  
  // Check results BEFORE shutdown
  const snapshot = orch.getConversationSnapshot(conversationId);
  const messages = snapshot.events.filter(e => e.type === 'message');
  
  console.log(`\nTotal messages: ${messages.length}`);
  console.log('Message flow:');
  for (const msg of messages) {
    console.log(`  ${msg.agentId}: "${(msg.payload as any).text}"`);
  }
  
  // Clean up
  agentA.stop();
  agentB.stop();
  await app.shutdown();
  
  if (messages.length >= 4) {
    console.log('\n✅ Turn loop executor working correctly!');
  } else {
    console.log('\n❌ Not enough messages exchanged');
    process.exit(1);
  }
}

testTurnLoop().catch(console.error);