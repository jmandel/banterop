#!/usr/bin/env bun
// Demo 5: Interactive Scenario Builder
//
// This demo shows how to interactively build and test scenarios:
// 1. Connect to existing server
// 2. Create a custom scenario interactively
// 3. Launch a conversation using the scenario
// 4. Allow user to send messages and see agent responses
// 5. Demonstrates scenario-driven agent behavior

import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import * as readline from 'readline';

// Connect to existing server
const WS_URL = process.env.WS_URL || 'ws://localhost:3000/api/ws';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const prompt = (question: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
};

console.log('🏗️  Interactive Scenario Builder\n');
console.log('This demo lets you create and test custom scenarios.\n');

(async () => {
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

  try {
    // Step 1: Gather scenario information
    console.log('📋 Let\'s build a scenario:\n');
    
    const scenarioName = await prompt('Scenario name: ');
    const scenarioDesc = await prompt('Scenario description: ');
    const numAgents = parseInt(await prompt('Number of agents (2-4): ')) || 2;
    
    const agents = [];
    for (let i = 0; i < numAgents; i++) {
      console.log(`\n🤖 Agent ${i + 1}:`);
      const agentId = await prompt('  Agent ID: ');
      const principal = await prompt('  Principal/Role: ');
      const goal = await prompt('  Goal: ');
      const systemPrompt = await prompt('  System prompt: ');
      
      agents.push({
        agentId,
        principal,
        goal,
        systemPrompt
      });
    }
    
    // Add user agent
    agents.push({
      agentId: 'user',
      principal: 'User',
      goal: 'Interact with the scenario',
      systemPrompt: 'You are the user interacting with the scenario.'
    });
    
    console.log('\n📝 Shared Knowledge (optional):');
    const sharedFactsStr = await prompt('Enter shared facts (comma-separated): ');
    const sharedFacts = sharedFactsStr ? sharedFactsStr.split(',').map(s => s.trim()) : [];
    
    // Step 2: Create the scenario
    const scenarioId = `custom-scenario-${Date.now()}`;
    const scenario: ScenarioConfiguration = {
      metadata: {
        id: scenarioId,
        name: scenarioName,
        description: scenarioDesc,
        version: '1.0.0'
      },
      agents,
      knowledge: {
        sharedFacts
      }
    };
    
    console.log('\n💾 Creating scenario...');
    await sendRequest('createScenario', {
      id: scenarioId,
      name: scenarioName,
      config: scenario
    });
    console.log('✅ Scenario created!\n');
    
    // Step 3: Create conversation with the scenario
    console.log('🎭 Creating conversation with your scenario...');
    
    // Build agent metadata for conversation
    const conversationAgents = agents.map((a, idx) => ({
      id: a.agentId,
      kind: a.agentId === 'user' ? 'external' : 'internal',
      displayName: a.principal,
      agentClass: a.agentId === 'user' ? undefined : 'ScenarioDrivenAgent',
      config: a.agentId === 'user' ? {} : { llmProvider: 'mock' }
    }));
    
    const { conversationId } = await sendRequest('createConversation', {
      meta: {
        title: scenarioName,
        description: scenarioDesc,
        scenarioId,
        agents: conversationAgents
      }
    });
    console.log(`✅ Created conversation ${conversationId}\n`);
    
    // Step 4: Subscribe to events
    const { subId } = await sendRequest('subscribe', {
      conversationId,
      includeGuidance: true
    });
    
    let currentTurn = null;
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'event') {
        const e = data.params;
        if (e.type === 'message') {
          if (e.agentId !== 'user') {
            console.log(`\n[${e.agentId}]: ${e.payload.text}`);
          }
          // Update lastClosedSeq when a turn closes
          if (e.finality !== 'none' && e.seq) {
            lastClosedSeq = e.seq;
          }
        }
      } else if (data.method === 'guidance') {
        currentTurn = data.params.nextAgentId;
        if (currentTurn !== 'user') {
          console.log(`  → Next: ${currentTurn}`);
        }
      }
    });
    
    // Step 5: Start server-side agents
    console.log('🚀 Starting scenario agents on server...');
    await sendRequest('runConversationToCompletion', { conversationId });
    console.log('✅ Agents are ready!\n');
    
    // Step 6: Interactive conversation
    console.log('💬 Start chatting! Type your messages below.');
    console.log('   (Type "exit" to end the conversation)\n');
    console.log('─'.repeat(60));
    
    while (true) {
      const message = await prompt('\nYou: ');
      
      if (message.toLowerCase() === 'exit') {
        console.log('\n🏁 Ending conversation...');
        await sendRequest('sendMessage', {
          conversationId,
          agentId: 'user',
          messagePayload: { text: 'Thank you all. Goodbye!' },
          finality: 'conversation',
          precondition: { lastClosedSeq }
        });
        break;
      }
      
      // Send user message
      await sendRequest('sendMessage', {
        conversationId,
        agentId: 'user',
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
    ws.close();
    rl.close();
    process.exit(1);
  }
})();