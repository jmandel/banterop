#!/usr/bin/env bun

/**
 * Demo: Server-managed scenario agents for knee MRI prior authorization
 * 
 * This demo creates a conversation with the knee MRI scenario and starts
 * both agents (patient and insurance) as server-managed scenario-driven agents.
 * 
 * Usage:
 *   bun run src/cli/demo-scenario-agents.ts
 *   bun run src/cli/demo-scenario-agents.ts --ws ws://localhost:3001/api/ws
 */

import { App } from '$src/server/app';
import { createScenarioConfiguration } from './scenarios/knee-mri-scenario';
import { ScenarioDrivenAgent } from '$src/agents/scenario/scenario-driven.agent';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import { InProcessEvents } from '$src/agents/runtime/inprocess.events';
import type { UnifiedEvent } from '$src/types/event.types';

// Parse command line arguments
const args = process.argv.slice(2);
const wsUrlIndex = args.indexOf('--ws');
const wsUrl = wsUrlIndex !== -1 && args[wsUrlIndex + 1]! 
  ? args[wsUrlIndex + 1] 
  : 'ws://localhost:3000/api/ws';

console.log(`
╭────────────────────────────────────────────────────╮
│     Scenario-Driven Agents Demo                    │
│     Knee MRI Prior Authorization                   │
├────────────────────────────────────────────────────┤
│  This demo creates a realistic prior auth          │
│  conversation between a patient representative     │
│  and an insurance specialist.                      │
│                                                    │
│  WebSocket URL: ${wsUrl.padEnd(35)}│
╰────────────────────────────────────────────────────╯
`);

async function runDemo() {
  // Step 1: Create app with in-memory database
  console.log('\n📦 Setting up application...');
  const app = new App({ 
    dbPath: ':memory:',
    defaultLlmProvider: 'mock'
  });
  
  const orchestrator = app.orchestrator;
  const providerManager = app.llmProviderManager;
  const isMockProvider = app.configManager.defaultLlmProvider === 'mock';
  
  // Step 2: Create and insert the scenario
  console.log('\n📋 Creating knee MRI scenario...');
  const scenarioConfig = createScenarioConfiguration();
  
  // Insert scenario into the database
  orchestrator.storage.scenarios.insertScenario({
    id: scenarioConfig.metadata.id,
    name: scenarioConfig.metadata.title,
    config: scenarioConfig,
    history: []
  });
  
  console.log(`   ✓ Scenario "${scenarioConfig.metadata.title}" created`);
  
  // Step 3: Create conversation with the scenario
  console.log('\n💬 Creating conversation...');
  const conversationId = orchestrator.createConversation({
    meta: {
      title: 'Knee MRI Prior Auth - Demo',
      scenarioId: scenarioConfig.metadata.id,
      agents: [
        { id: 'patient-agent', kind: 'internal' },
        { id: 'insurance-auth-specialist', kind: 'internal' }
      ],
      custom: {
        autoRun: true // Enable auto-run for continuous execution
      }
    }
  });
  
  console.log(`   ✓ Conversation ${conversationId} created`);
  
  // Step 4: Set up event monitoring
  console.log('\n👁️  Monitoring conversation events...\n');
  console.log('─'.repeat(60));
  
  let messageCount = 0;
  const maxMessages = 10; // Limit for demo with mock provider
  const startTime = Date.now();
  
  orchestrator.subscribe(conversationId, (event: UnifiedEvent) => {
    if (event.type === 'message') {
      messageCount++;
      const payload = event.payload as any;
      const agent = event.agentId === 'patient-agent' ? '🧑 Patient' : '🏢 Insurance';
      const text = payload.text || '';
      
      // Format and display the message
      console.log(`\n${agent} [Turn ${event.turn}]:`);
      console.log('   ' + text.split('\n').join('\n   '));
      
      // Auto-end after max messages with mock provider
      if (messageCount >= maxMessages && isMockProvider) {
        console.log('\n' + '─'.repeat(60));
        console.log('📝 Demo limit reached (mock provider)');
        
        // End the conversation
        orchestrator.sendMessage(
          conversationId,
          'system',
          { text: 'Demo completed - conversation limit reached.' },
          'conversation'
        );
      }
      
      // Check for conversation end
      if (event.finality === 'conversation') {
        console.log('\n' + '─'.repeat(60));
        console.log('✅ Conversation completed!');
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   Total messages: ${messageCount}`);
        console.log(`   Duration: ${duration}s`);
        
        // Show final status
        const snapshot = orchestrator.getConversationSnapshot(conversationId);
        console.log(`   Final status: ${snapshot.status}`);
        
        // Check if there was an approval or denial
        const lastMessage = snapshot.events
          .filter(e => e.type === 'message')
          .pop() as any;
        
        if (lastMessage?.payload?.text?.includes('approved')) {
          console.log('\n🎉 MRI Authorization APPROVED!');
        } else if (lastMessage?.payload?.text?.includes('denied')) {
          console.log('\n❌ MRI Authorization DENIED');
        }
      }
    } else if (event.type === 'trace') {
      // Optionally show trace events for debugging
      const payload = event.payload as any;
      if (payload.type === 'tool_call') {
        console.log(`   🔧 [${event.agentId}] Tool: ${payload.name}`);
      }
    }
  }, false);
  
  // Step 5: Create and start the agents
  console.log('\n🤖 Starting scenario-driven agents...');
  
  // Create transport
  const transport = new InProcessTransport(orchestrator);
  
  // Patient agent
  const patientEvents = new InProcessEvents(orchestrator, conversationId, true);
  const patientAgent = new ScenarioDrivenAgent(transport, patientEvents, {
    agentId: 'patient-agent',
    providerManager
  });
  
  // Insurance agent  
  const insuranceEvents = new InProcessEvents(orchestrator, conversationId, true);
  const insuranceAgent = new ScenarioDrivenAgent(transport, {
    agentId: 'insurance-auth-specialist',
    providerManager
  });
  
  // Start both agents
  await Promise.all([
    patientAgent.start(conversationId, 'patient-agent'),
    insuranceAgent.start(conversationId, 'insurance-auth-specialist')
  ]);
  
  console.log('   ✓ Agents started and waiting for guidance');
  
  // Step 6: Kick off the conversation with the patient's initial message
  console.log('\n🚀 Starting conversation...\n');
  console.log('─'.repeat(60));
  
  orchestrator.sendMessage(
    conversationId,
    'patient-agent',
    { text: scenarioConfig.agents[0]!.messageToUseWhenInitiatingConversation || 'Hello, I need help with prior authorization.' },
    'turn'
  );
  
  // Step 7: Wait for conversation to complete (with timeout)
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      const snapshot = orchestrator.getConversationSnapshot(conversationId);
      if (snapshot.status === 'completed') {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);
    
    // Timeout after 30 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
      console.log('\n⏱️  Demo timeout reached (30s)');
      resolve();
    }, 30000);
  });
  
  // Step 8: Clean up
  console.log('\n🧹 Cleaning up...');
  patientAgent.stop();
  insuranceAgent.stop();
  await app.shutdown();
  
  console.log('\n✨ Demo complete!\n');
}

// Run the demo
runDemo().catch(err => {
  console.error('\n❌ Demo failed:', err);
  process.exit(1);
});