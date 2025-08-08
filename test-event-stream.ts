#!/usr/bin/env bun
import { App } from './src/server/app';
import { createEventStream } from './src/agents/clients/event-stream';
import type { StreamEvent } from './src/agents/clients/event-stream';

async function testEventStream() {
  console.log('Testing event stream helper...\n');
  
  const app = new App({ 
    dbPath: ':memory:', 
    emitGuidance: true,
    emitNextCandidates: false
  });
  
  const orch = app.orchestrator;
  const conversationId = orch.createConversation({ title: 'Stream Test' });
  
  // Create event stream
  const stream = createEventStream(orch, {
    conversationId,
    includeGuidance: true,
  });
  
  // Start consuming events in background
  const events: StreamEvent[] = [];
  const consumer = (async () => {
    console.log('Starting event consumer...');
    for await (const event of stream) {
      if ('type' in event && event.type === 'guidance') {
        console.log(`[STREAM] Guidance: nextAgent=${event.nextAgentId}`);
      } else {
        const e = event as any;
        console.log(`[STREAM] Event: type=${e.type} agent=${e.agentId} finality=${e.finality}`);
      }
      events.push(event);
      
      // Stop after conversation ends
      if ('type' in event && event.type === 'message' && (event as any).finality === 'conversation') {
        break;
      }
    }
    console.log('Event consumer stopped');
  })();
  
  // Give consumer time to start
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Generate some events
  console.log('\nGenerating events...');
  
  orch.appendEvent({
    conversation: conversationId,
    type: 'message',
    payload: { text: 'Hello' },
    finality: 'turn',
    agentId: 'user',
  });
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  orch.appendEvent({
    conversation: conversationId,
    type: 'message',
    payload: { text: 'Hi there' },
    finality: 'turn',
    agentId: 'assistant',
  });
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  orch.appendEvent({
    conversation: conversationId,
    type: 'message',
    payload: { text: 'Goodbye' },
    finality: 'conversation',
    agentId: 'user',
  });
  
  // Wait for consumer to finish
  await consumer;
  
  console.log(`\nReceived ${events.length} events`);
  
  // Verify we got both regular events and guidance
  const hasGuidance = events.some(e => 'type' in e && e.type === 'guidance');
  const hasMessages = events.some(e => 'type' in e && e.type === 'message');
  const hasConversationEnd = events.some(e => 
    'type' in e && e.type === 'message' && (e as any).finality === 'conversation'
  );
  
  await app.shutdown();
  
  if (hasGuidance && hasMessages && hasConversationEnd) {
    console.log('\n✅ Event stream working correctly!');
  } else {
    console.log('\n❌ Event stream has issues');
    console.log('hasGuidance:', hasGuidance);
    console.log('hasMessages:', hasMessages);
    console.log('hasConversationEnd:', hasConversationEnd);
    process.exit(1);
  }
}

testEventStream().catch(console.error);