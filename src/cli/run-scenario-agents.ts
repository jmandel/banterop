#!/usr/bin/env bun
import { App } from '$src/server/app';
import { createScenarioConversation } from '$src/agents/factories/scenario-agent.factory';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import { colors, logLine } from '$src/lib/utils/logger';

// Create a test scenario with two agents
const testScenario: ScenarioConfiguration = {
  metadata: {
    id: 'negotiation-scenario',
    title: 'Price Negotiation',
    description: 'A buyer and seller negotiate over a used car',
    tags: ['negotiation', 'demo'],
  },
  scenario: {
    background: 'A used car dealership negotiation',
    challenges: ['Find mutually acceptable price', 'Address concerns about car condition'],
  },
  agents: [
    {
      agentId: 'buyer',
      principal: {
        type: 'individual',
        name: 'Alex Buyer',
        description: 'A cautious buyer looking for a good deal',
      },
      situation: 'You are at a used car dealership looking at a 2018 Honda Civic',
      systemPrompt: 'You are a cautious buyer. You want to get a good price and are concerned about the car\'s condition. Start by asking about the price and condition.',
      goals: [
        'Get the price below $15,000',
        'Ensure the car is in good condition',
        'Get warranty if possible',
      ],
      tools: [],
      knowledgeBase: {
        budget: 15000,
        maxBudget: 16000,
      },
      messageToUseWhenInitiatingConversation: 'Hi, I\'m interested in the 2018 Honda Civic. What\'s your asking price, and can you tell me about its condition?',
    },
    {
      agentId: 'seller',
      principal: {
        type: 'individual',
        name: 'Sam Seller',
        description: 'An experienced car salesperson',
      },
      situation: 'You are selling a 2018 Honda Civic at your dealership',
      systemPrompt: 'You are an experienced salesperson. The car is listed at $17,500 but you can go as low as $15,500. The car is in excellent condition with low mileage.',
      goals: [
        'Sell the car for at least $15,500',
        'Highlight the car\'s excellent condition',
        'Close the deal today',
      ],
      tools: [],
      knowledgeBase: {
        listPrice: 17500,
        minimumPrice: 15500,
        mileage: 35000,
        condition: 'excellent',
      },
    },
  ],
};

async function main() {
  const appInstance = new App({ dbPath: ':memory:' });
  
  logLine('DEMO', colors.bright('Scenario-Driven Agents Demo'));
  logLine('DEMO', colors.cyan('Creating negotiation scenario...'));
  
  // Store the scenario
  appInstance.orchestrator.storage.scenarios.insertScenario({
    id: testScenario.metadata.id,
    name: testScenario.metadata.title,
    config: testScenario,
    history: [],
  });
  
  // Create conversation with scenario-driven agents
  const { conversationId, handle } = await createScenarioConversation(
    appInstance.orchestrator,
    appInstance.providerManager,
    {
      scenarioId: testScenario.metadata.id,
      title: 'Car Negotiation Session',
      agents: [
        {
          id: 'buyer',
          kind: 'external',  // Buyer will start
        },
        {
          id: 'seller',
          kind: 'internal',  // Seller is scenario-driven
          config: {
            llmProvider: 'mock',  // Using mock for demo
          },
        },
      ],
      startingAgentId: 'buyer',  // Buyer starts the conversation
    }
  );
  
  logLine('DEMO', colors.green(`Created conversation ${conversationId}`));
  logLine('DEMO', colors.cyan('Starting internal agent for seller...'));
  
  // Simulate buyer's first message
  await new Promise(resolve => setTimeout(resolve, 100));
  
  logLine('buyer', colors.yellow('SEND'), 'Sending initial message...');
  appInstance.orchestrator.appendEvent({
    conversation: conversationId,
    type: 'message',
    payload: { 
      text: testScenario.agents[0]!.messageToUseWhenInitiatingConversation!,
    },
    finality: 'turn',
    agentId: 'buyer',
  });
  
  // Wait for seller's response
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Get conversation snapshot to see the response
  const snapshot = appInstance.orchestrator.getConversationSnapshot(conversationId);
  const messages = snapshot.events.filter(e => e.type === 'message');
  
  logLine('DEMO', colors.bright('Conversation Transcript:'));
  for (const msg of messages) {
    const payload = msg.payload as any;
    logLine(msg.agentId, colors.cyan('MSG'), payload.text);
  }
  
  // Simulate another round
  logLine('buyer', colors.yellow('SEND'), 'That seems high. Can you do better on the price?');
  appInstance.orchestrator.appendEvent({
    conversation: conversationId,
    type: 'message',
    payload: { 
      text: 'That seems high. I was hoping for something closer to $14,000. Also, has it had any accidents?',
    },
    finality: 'turn',
    agentId: 'buyer',
  });
  
  // Wait for response
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Show final state
  const finalSnapshot = appInstance.orchestrator.getConversationSnapshot(conversationId);
  const finalMessages = finalSnapshot.events.filter(e => e.type === 'message');
  
  logLine('DEMO', colors.bright('Final Conversation:'));
  for (const msg of finalMessages) {
    const payload = msg.payload as any;
    logLine(msg.agentId, msg.agentId === 'buyer' ? colors.yellow('→') : colors.green('←'), payload.text);
  }
  
  // Clean up
  await handle.stop();
  await appInstance.shutdown();
  
  logLine('DEMO', colors.bright('✓ Demo complete!'));
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});