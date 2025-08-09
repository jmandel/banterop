#!/usr/bin/env bun

/**
 * Demo: Internal scenario agents for knee MRI prior authorization
 * 
 * This demo creates a conversation with the knee MRI scenario and starts
 * both agents (patient and insurance) as internal scenario-driven agents.
 * 
 * Usage:
 *   bun run src/cli/demo-scenario-agents.ts
 *   LLM_PROVIDER=google bun run src/cli/demo-scenario-agents.ts
 */

import { App } from '$src/server/app';
import { createScenarioConfiguration } from './scenarios/knee-mri-scenario';
import { ScenarioDrivenAgent } from '$src/agents/scenario/scenario-driven.agent';
import { ScriptAgent } from '$src/agents/script/script.agent';
import type { TurnBasedScript } from '$src/agents/script/script.types';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import type { UnifiedEvent } from '$src/types/event.types';

// Define turn-based scripts for the demo agents
const patientScript: TurnBasedScript = {
  name: 'patient-knee-mri',
  defaultDelay: 100,
  maxTurns: 5,
  turns: [
    [{ kind: 'post', text: 'Hello, I need help with prior authorization for my knee MRI. My doctor says I need one.', finality: 'turn' }],
    [{ kind: 'post', text: 'Yes, I\'ve been having severe knee pain for about 3 weeks now. It\'s getting worse when I walk or climb stairs.', finality: 'turn' }],
    [{ kind: 'post', text: 'I tried physical therapy for 6 weeks as my doctor recommended, but unfortunately it hasn\'t helped. The pain is still about 7 out of 10.', finality: 'turn' }],
    [{ kind: 'post', text: 'Yes, I have the referral from Dr. Smith dated last week. She documented the failed conservative treatment.', finality: 'turn' }],
    [{ kind: 'post', text: 'Thank you so much for your help! When can I schedule the MRI?', finality: 'conversation' }]
  ]
};

const insuranceScript: TurnBasedScript = {
  name: 'insurance-auth-specialist',
  defaultDelay: 100,
  maxTurns: 5,
  turns: [
    [{ kind: 'post', text: 'Hello! I see you need prior authorization for a knee MRI. Let me review your case. Can you tell me about your symptoms?', finality: 'turn' }],
    [{ kind: 'post', text: 'I understand. For insurance approval, we need to verify that conservative treatment was attempted first. Have you tried physical therapy?', finality: 'turn' }],
    [{ kind: 'post', text: 'Thank you for that information. With 6 weeks of failed physical therapy and pain level of 7/10, this meets our criteria. Do you have a referral from your primary care physician?', finality: 'turn' }],
    [{ kind: 'post', text: 'Perfect. Based on your documented symptoms, failed conservative treatment, and physician referral, I can approve the prior authorization for your knee MRI.', finality: 'turn' }],
    [{ kind: 'post', text: 'Your prior authorization has been approved. Reference number: PA-2024-KM-' + Math.floor(Math.random() * 10000) + '. You can call your doctor\'s office to schedule the MRI. The authorization is valid for 30 days.', finality: 'conversation' }]
  ]
};

console.log(`
╭────────────────────────────────────────────────────╮
│     Internal Scenario Agents Demo                  │
│     Knee MRI Prior Authorization                   │
├────────────────────────────────────────────────────┤
│  This demo creates a realistic prior auth          │
│  conversation between a patient representative     │
│  and an insurance specialist.                      │
│                                                    │
│  Provider: ${(process.env.LLM_PROVIDER || 'mock').padEnd(40)}│
╰────────────────────────────────────────────────────╯
`);

async function runDemo() {
  // Step 1: Create app with in-memory database
  console.log('\n📦 Setting up application...');
  const defaultProvider = (process.env.LLM_PROVIDER as any) || 'mock';
  const app = new App({ 
    dbPath: ':memory:',
    defaultLlmProvider: defaultProvider,
    googleApiKey: process.env.GEMINI_API_KEY,
    openRouterApiKey: process.env.OPENROUTER_API_KEY
  });
  
  const orchestrator = app.orchestrator;
  const providerManager = app.llmProviderManager;
  const useMockScripts = defaultProvider === 'mock';
  
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
      title: 'Internal Knee MRI Prior Auth',
      scenarioId: scenarioConfig.metadata.id,
      startingAgentId: 'patient-agent',  // Patient starts the conversation
      agents: [
        { id: 'patient-agent' },
        { id: 'insurance-auth-specialist' }
      ]
    }
  });
  
  console.log(`   ✓ Conversation ${conversationId} created`);
  
  // Step 4: Set up event monitoring
  console.log('\n👁️  Monitoring conversation events...\n');
  console.log('─'.repeat(60));
  
  let messageCount = 0;
  const startTime = Date.now();
  let turnCount = 0;
  const MAX_TURNS = 20;
  let lastMessageTime = Date.now();
  
  orchestrator.subscribe(conversationId, async (event: UnifiedEvent) => {
    if (event.type === 'message') {
      // Add 100ms pause between turns for better readability
      const timeSinceLastMessage = Date.now() - lastMessageTime;
      if (timeSinceLastMessage < 100) {
        await new Promise(resolve => setTimeout(resolve, 100 - timeSinceLastMessage));
      }
      lastMessageTime = Date.now();
      
      messageCount++;
      
      // Track turns (each message with finality 'turn' increments the turn count)
      if (event.finality === 'turn' || event.finality === 'conversation') {
        turnCount++;
      }
      
      const payload = event.payload as any;
      const agent = event.agentId === 'patient-agent' ? '🧑 Patient' : 
                   event.agentId === 'insurance-auth-specialist' ? '🏢 Insurance' :
                   `📢 ${event.agentId}`;
      const text = payload.text || '';
      
      console.log(`\n${agent} [Turn ${event.turn}]:`);
      console.log('   ' + text.split('\n').join('\n   '));
      
      // Check if we've reached the turn limit (just for monitoring)
      if (turnCount >= MAX_TURNS && event.finality === 'turn') {
        console.log('\n' + '─'.repeat(60));
        console.log(`⚠️  Turn limit reached (${MAX_TURNS} turns). Agents should conclude soon...`);
      }
      
      // Check for conversation end
      if (event.finality === 'conversation') {
        console.log('\n' + '─'.repeat(60));
        console.log('✅ Conversation completed!');
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   Total messages: ${messageCount}`);
        console.log(`   Total turns: ${turnCount}`);
        console.log(`   Duration: ${duration}s`);
        
        // Show final status
        const snapshot = orchestrator.getConversationSnapshot(conversationId);
        console.log(`   Final status: ${snapshot.status}`);
      }
    }
  }, false);
  
  // Step 5: Create and start the agents
  console.log(`\n🤖 Starting agents (using ${useMockScripts ? 'scripts' : 'LLM provider'})...`);
  
  // Create transport
  const transport = new InProcessTransport(orchestrator);
  
  const agents: any[] = [];
  
  // Use ScriptAgent for mock provider, ScenarioDrivenAgent for real LLMs
  // Patient agent
  const patientAgent = useMockScripts 
    ? new ScriptAgent(transport, patientScript)
    : new ScenarioDrivenAgent(transport, {
        agentId: 'patient-agent',
        providerManager
      });
  agents.push(patientAgent);
  
  // Insurance agent  
  const insuranceAgent = useMockScripts
    ? new ScriptAgent(transport, insuranceScript)
    : new ScenarioDrivenAgent(transport, {
        agentId: 'insurance-auth-specialist',
        providerManager
      });
  agents.push(insuranceAgent);
  
  // Start both agents
  await Promise.all([
    patientAgent.start(conversationId, 'patient-agent'),
    insuranceAgent.start(conversationId, 'insurance-auth-specialist')
  ]);
  
  console.log('   ✓ Agents started and waiting for guidance');
  
  // The conversation will start automatically via startingAgentId guidance
  console.log('\n⏳ Waiting for agents to begin conversation...\n');
  console.log('─'.repeat(60));
  
  // Step 6: Wait for conversation to complete (with timeout)
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      const snapshot = orchestrator.getConversationSnapshot(conversationId);
      if (snapshot.status === 'completed') {
        clearInterval(checkInterval);
        // Give time for final messages to display
        setTimeout(() => resolve(), 1000);
      }
    }, 100);
    
    // Timeout after 30 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
      console.log('\n⏱️  Demo timeout reached (30s)');
      resolve();
    }, 30000);
  });
  
  // Step 7: Clean up
  console.log('\n🧹 Cleaning up...');
  agents.forEach(a => a.stop());
  await app.shutdown();
  
  console.log('\n✨ Demo complete!\n');
  process.exit(0);
}

// Run the demo
runDemo().catch(err => {
  console.error('\n❌ Demo failed:', err);
  process.exit(1);
});