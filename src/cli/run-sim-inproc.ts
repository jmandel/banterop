#!/usr/bin/env bun
import { App } from '$src/server/app';
import { InternalTurnLoop } from '$src/agents/executors/internal-turn-loop';
import { EchoAgent } from '$src/agents/echo.agent';
import type { UnifiedEvent } from '$src/types/event.types';

function printEvent(e: UnifiedEvent) {
  const text = e.type === 'message' 
    ? ((e.payload as { text?: string }).text ?? '') 
    : JSON.stringify(e.payload);
  console.log(`[${e.seq}] (${e.turn}:${e.event}) ${e.agentId} ${e.type}/${e.finality} :: ${text}`);
}

async function main() {
  const app = new App({ 
    dbPath: ':memory:'
  });
  const orch = app.orchestrator;

  const conversationId = orch.createConversation({ title: 'InProc Sim' });
  const subId = orch.subscribe(conversationId, printEvent);

  const agentA = new InternalTurnLoop(
    new EchoAgent('Agent A thinking...', 'Agent A done'),
    orch,
    { conversationId, agentId: 'agent-a' }
  );
  
  const agentB = new InternalTurnLoop(
    new EchoAgent('Agent B thinking...', 'Agent B done'),
    orch,
    { conversationId, agentId: 'agent-b' }
  );

  console.log(`Starting in-process simulation for conversation ${conversationId}`);
  
  // Start both agents
  const taskA = agentA.start();
  const taskB = agentB.start();
  
  // Trigger conversation with initial message
  await sleep(100);
  orch.sendMessage(conversationId, 'user', { text: 'Start' }, 'turn');
  
  // Let them exchange a few messages
  await sleep(500);
  
  orch.sendMessage(conversationId, 'user', { text: 'Closing' }, 'conversation');

  // Wait for agents to stop
  await Promise.race([
    Promise.all([taskA, taskB]),
    sleep(1000)
  ]);
  
  agentA.stop();
  agentB.stop();
  orch.unsubscribe(subId);
  await app.shutdown();
  console.log('In-process simulation completed.');
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});