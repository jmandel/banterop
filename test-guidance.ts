#!/usr/bin/env bun
import { App } from './src/server/app';
import type { UnifiedEvent } from './src/types/event.types';
import type { GuidanceEvent } from './src/types/orchestrator.types';

async function testGuidance() {
  console.log('Testing guidance event emission...\n');
  
  // Create app with guidance enabled
  const app = new App({ 
    dbPath: ':memory:', 
    emitGuidance: true,  // Enable new guidance events
    emitNextCandidates: false  // Disable legacy system events
  });
  
  const orch = app.orchestrator;
  const conversationId = orch.createConversation({ title: 'Guidance Test' });
  
  // Subscribe with guidance enabled
  const received: Array<UnifiedEvent | GuidanceEvent> = [];
  const subId = orch.subscribe(
    conversationId, 
    (e: UnifiedEvent | GuidanceEvent) => {
      if ('type' in e && e.type === 'guidance') {
        console.log(`[GUIDANCE] seq=${e.seq} nextAgent=${e.nextAgentId} deadline=${e.deadlineMs}ms`);
      } else {
        const event = e as UnifiedEvent;
        console.log(`[EVENT] seq=${event.seq} type=${event.type} agent=${event.agentId} finality=${event.finality}`);
      }
      received.push(e);
    },
    true // includeGuidance = true
  );
  
  // User sends a message with turn finality
  console.log('User posting message with turn finality...');
  orch.appendEvent({
    conversation: conversationId,
    type: 'message',
    payload: { text: 'Hello assistant' },
    finality: 'turn',
    agentId: 'user',
  });
  
  // Check what we received
  await new Promise(resolve => setTimeout(resolve, 100));
  
  console.log(`\nReceived ${received.length} events:`);
  for (const e of received) {
    if ('type' in e && e.type === 'guidance') {
      console.log('  - Guidance event for', (e as GuidanceEvent).nextAgentId);
    } else {
      console.log('  - Regular event:', (e as UnifiedEvent).type);
    }
  }
  
  // Cleanup
  orch.unsubscribe(subId);
  await app.shutdown();
  
  // Verify we got a guidance event
  const hasGuidance = received.some(e => 'type' in e && e.type === 'guidance');
  if (hasGuidance) {
    console.log('\n✅ Guidance events working correctly!');
  } else {
    console.log('\n❌ No guidance event received');
    process.exit(1);
  }
}

testGuidance().catch(console.error);