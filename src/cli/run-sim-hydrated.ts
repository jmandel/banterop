#!/usr/bin/env bun
import { App } from '$src/server/app';
import { Hono } from 'hono';
import { createConversationRoutes } from '$src/server/routes/conversations.http';
import { createScenarioRoutes } from '$src/server/routes/scenarios.http';
import { createWebSocketServer, websocket } from '$src/server/ws/jsonrpc.server';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';

// Create a simple test scenario using v2 structure
const testScenario: ScenarioConfiguration = {
  metadata: {
    id: 'test-scenario-v1',
    title: 'Test Scenario',
    description: 'A simple test scenario for validation',
    tags: ['test', 'demo'],
  },
  scenario: {
    background: 'This is a test scenario to validate the system',
    challenges: ['Testing the conversation flow', 'Validating scenario hydration'],
    interactionNotes: { testRun: true },
  },
  agents: [
    {
      agentId: 'user',
      principal: {
        type: 'individual',
        name: 'Test User',
        description: 'The user requesting assistance',
      },
      situation: 'You need help with a test request',
      systemPrompt: 'You are a user asking for help',
      goals: ['Get help with their request'],
      tools: [],
      knowledgeBase: {},
      messageToUseWhenInitiatingConversation: 'Hello, I need help with a test',
    },
    {
      agentId: 'assistant',
      principal: {
        type: 'individual',
        name: 'Test Assistant', 
        description: 'The AI assistant helping the user',
      },
      situation: 'You are helping a user with their request',
      systemPrompt: 'You are a helpful assistant.',
      goals: ['Help the user effectively'],
      tools: [
        {
          toolName: 'get_test_info',
          description: 'Retrieves test information',
          inputSchema: { type: 'object', properties: {} },
          synthesisGuidance: 'Return basic test information from the knowledge base',
        }
      ],
      knowledgeBase: {
        testData: 'This is test data from the knowledge base',
      },
    },
  ],
};

async function main() {
  const appInstance = new App({ dbPath: ':memory:' });
  const server = new Hono()
    .route('/', createConversationRoutes(appInstance.orchestrator))
    .route('/api/scenarios', createScenarioRoutes(appInstance.orchestrator.storage.scenarios))
    .route('/', createWebSocketServer(appInstance.orchestrator));
  
  const bunServer = Bun.serve({ 
    port: 0, 
    fetch: server.fetch,
    websocket,
  });
  
  const port = bunServer.port;
  console.log(`Server running on port ${port}`);

  // STEP 1: Create the scenario template via the new API
  const createScenarioRes = await fetch(`http://localhost:${port}/api/scenarios`, {
    method: 'POST',
    body: JSON.stringify({ 
      name: 'Test Scenario Template', 
      config: testScenario 
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  
  if (!createScenarioRes.ok) {
    const error = await createScenarioRes.text();
    throw new Error(`Failed to create scenario: ${error}`);
  }
  
  console.log(`✅ Scenario template '${testScenario.metadata.id}' created.`);

  // STEP 2: Create a conversation INSTANCE, providing RUNTIME-specific config
  // This is where we explicitly configure which agents are internal/external and their implementation
  const createConvoRes = await fetch(`http://localhost:${port}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenarioId: testScenario.metadata.id,
      title: "Test Conversation (Runtime Override)",
      startingAgentId: 'assistant',  // Configure which agent starts the conversation
      agents: [
        { 
          id: 'user',           // matches agentId from scenario
          kind: 'external',     // explicitly external (human/client-driven)
          agentClass: 'HumanAgent',  // or could be a bot client
        },
        { 
          id: 'assistant',      // matches agentId from scenario  
          kind: 'internal',     // explicitly internal (orchestrator-driven)
          agentClass: 'AssistantAgent',  // which agent implementation to use
          config: {             // configuration for the AssistantAgent
            llmProvider: 'mock',
            model: 'gpt-4o-mini', 
            temperature: 0.7 
          } 
        },
      ],
      custom: {
        testRun: true,
        environment: 'development',
      },
    }),
  });
  
  if (!createConvoRes.ok) {
    const error = await createConvoRes.text();
    throw new Error(`Failed to create conversation: ${error}`);
  }
  
  const convo = await createConvoRes.json();
  const conversationId = convo.conversation;
  console.log(`✅ Conversation ${conversationId} instantiated from scenario.`);

  // STEP 3: Demonstrate hydration by fetching the merged view
  const hydrated = appInstance.orchestrator.getHydratedConversationSnapshot(conversationId);
  if (!hydrated) throw new Error("Hydration failed");

  console.log("\n--- Hydration Validation ---");
  console.log("Scenario ID:", hydrated.scenario?.metadata.id);
  console.log("Scenario Title:", hydrated.scenario?.metadata.title);
  console.log("Runtime Title:", hydrated.runtimeMeta.title);
  console.log("Scenario Agents:", hydrated.scenario?.agents.map(a => a.agentId).join(', '));
  
  const assistantScenarioDef = hydrated.scenario?.agents.find(a => a.agentId === 'assistant');
  const assistantRuntimeConfig = hydrated.runtimeMeta.agents?.find((a: any) => a.id === 'assistant');
  
  console.log("\nAssistant Configuration:");
  console.log("  From Scenario - System Prompt:", assistantScenarioDef?.systemPrompt);
  console.log("  From Scenario - Goals:", assistantScenarioDef?.goals);
  if (assistantRuntimeConfig) {
    console.log("  From Runtime - Model:", assistantRuntimeConfig.config?.model);
    console.log("  From Runtime - Temperature:", assistantRuntimeConfig.config?.temperature);
  }
  
  console.log("\nCustom Runtime Data:", hydrated.runtimeMeta.custom);
  console.log("--------------------------\n");

  // STEP 4: Test listing scenarios
  const listRes = await fetch(`http://localhost:${port}/api/scenarios`);
  const scenarios = await listRes.json();
  console.log(`✅ Listed ${scenarios.length} scenario(s)`);
  
  // STEP 5: Test getting a specific scenario
  const getRes = await fetch(`http://localhost:${port}/api/scenarios/${testScenario.metadata.id}`);
  const retrievedScenario = await getRes.json();
  console.log(`✅ Retrieved scenario '${retrievedScenario.name}'`);

  // STEP 6: Test conversation with scenario filter
  const filteredRes = await fetch(`http://localhost:${port}/api/conversations?scenarioId=${testScenario.metadata.id}`);
  const filteredConvos = await filteredRes.json();
  console.log(`✅ Found ${filteredConvos.length} conversation(s) using scenario '${testScenario.metadata.id}'`);

  // STEP 7: Add an event to the conversation to test the full flow
  appInstance.orchestrator.appendEvent({
    conversation: conversationId,
    type: 'message',
    payload: { text: 'Hello from the test!' },
    finality: 'turn',
    agentId: 'user',
  });
  
  const finalSnapshot = appInstance.orchestrator.getHydratedConversationSnapshot(conversationId);
  console.log(`✅ Added event, conversation now has ${finalSnapshot?.events.length} event(s)`);

  bunServer.stop(true);
  await appInstance.shutdown();
  console.log("\n🏁 Scenario-driven conversation validation completed successfully!");
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});