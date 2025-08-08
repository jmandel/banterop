#!/usr/bin/env bun
import { App } from './src/server/app';
import type { UnifiedEvent } from './src/types/event.types';
import type { GuidanceEvent } from './src/types/orchestrator.types';

async function testClaimMechanism() {
  console.log('Testing turn claim mechanism...\n');
  
  const app = new App({ 
    dbPath: ':memory:', 
    emitGuidance: true,
    emitNextCandidates: false
  });
  
  const orch = app.orchestrator;
  const conversationId = orch.createConversation({ title: 'Claim Test' });
  
  let guidanceSeq = 0;
  
  // Subscribe to get guidance
  orch.subscribe(
    conversationId,
    (e: UnifiedEvent | GuidanceEvent) => {
      if ('type' in e && e.type === 'guidance') {
        guidanceSeq = e.seq;
        console.log(`[GUIDANCE] seq=${e.seq} nextAgent=${e.nextAgentId}`);
      } else if (e.type === 'system') {
        const evt = e as UnifiedEvent;
        console.log(`[SYSTEM] ${(evt.payload as any).kind} data=${JSON.stringify((evt.payload as any).data)}`);
      }
    },
    true
  );
  
  // User posts a message to trigger guidance
  console.log('User posting message...');
  orch.appendEvent({
    conversation: conversationId,
    type: 'message',
    payload: { text: 'Hello' },
    finality: 'turn',
    agentId: 'user',
  });
  
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // Agent A tries to claim
  console.log('\nAgent A attempting to claim...');
  const claimA = await orch.claimTurn(conversationId, 'agent-a', guidanceSeq);
  console.log(`Agent A claim result: ${claimA.ok ? 'SUCCESS' : 'FAILED'} ${claimA.reason || ''}`);
  
  // Agent B tries to claim the same guidance
  console.log('\nAgent B attempting to claim same guidance...');
  const claimB = await orch.claimTurn(conversationId, 'agent-b', guidanceSeq);
  console.log(`Agent B claim result: ${claimB.ok ? 'SUCCESS' : 'FAILED'} ${claimB.reason || ''}`);
  
  // Agent A tries to reclaim (idempotent)
  console.log('\nAgent A attempting to reclaim (idempotent)...');
  const reclaimA = await orch.claimTurn(conversationId, 'agent-a', guidanceSeq);
  console.log(`Agent A reclaim result: ${reclaimA.ok ? 'SUCCESS' : 'FAILED'} ${reclaimA.reason || ''}`);
  
  // Test invalid claim
  console.log('\nAgent C attempting to claim non-existent guidance...');
  const claimC = await orch.claimTurn(conversationId, 'agent-c', 999.9);
  console.log(`Agent C claim result: ${claimC.ok ? 'SUCCESS' : 'FAILED'} ${claimC.reason || ''}`);
  
  await app.shutdown();
  
  // Verify results
  if (claimA.ok && !claimB.ok && reclaimA.ok && claimC.ok) {
    console.log('\n✅ Turn claim mechanism working correctly!');
  } else {
    console.log('\n❌ Turn claim mechanism has issues');
    process.exit(1);
  }
}

testClaimMechanism().catch(console.error);