#!/usr/bin/env bun
import { App } from '$src/server/app';
import { InternalTurnLoop } from '$src/agents/executors/internal-turn-loop';
import { AssistantAgent } from '$src/agents/assistant.agent';

// To run this:
// 1. Create a .env file:
//    OPENROUTER_API_KEY="sk-or-..."
//    or GOOGLE_API_KEY="..."
// 2. Run with bun: `bun run src/cli/run-sim-llm-agent.ts`

async function main() {
  console.log("Starting LLM Agent Simulation...");

  // 1. Initialize the application. This will create the ProviderManager
  //    and load API keys from the environment.
  const app = new App({ dbPath: ':memory:' });

  // 2. Get a default LLM provider from the manager
  //    This will use the `defaultLlmProvider` from the config.
  const llmProvider = app.providerManager.getProvider();
  console.log(`✅ Using default provider: ${llmProvider.getMetadata().name}`);

  // 3. Create an instance of our new LLM-powered agent
  const assistantAgent = new AssistantAgent(llmProvider);

  // 4. Create a conversation and an internal executor to run the agent
  const conversationId = app.orchestrator.createConversation({ title: 'LLM Agent Test' });
  const executor = new InternalTurnLoop(assistantAgent, app.orchestrator, {
    conversationId,
    agentId: 'assistant',
  });

  // Start the agent loop in the background
  const agentPromise = executor.start();

  // 5. Kick off the conversation with a user message
  console.log("\n--- SIMULATION START ---");
  await new Promise(res => setTimeout(res, 500)); // wait for agent to be ready

  app.orchestrator.sendMessage(
    conversationId,
    'user',
    { text: "Hello! Can you explain the concept of a black hole in simple terms?" },
    'turn'
  );

  // Wait for the agent to respond
  await new Promise(res => setTimeout(res, 10000)); // Allow time for API call

  // 6. Print the final conversation state
  const finalState = app.orchestrator.getConversationSnapshot(conversationId);
  console.log("\n--- SIMULATION END ---");
  finalState.events
    .filter(e => e.type === 'message')
    .forEach(e => {
      console.log(`[${e.agentId}]: ${(e.payload as any).text}`);
    });

  // End the conversation
  app.orchestrator.sendMessage(
    conversationId,
    'user',
    { text: "Thanks, goodbye!" },
    'conversation'
  );

  // Cleanup
  executor.stop();
  await agentPromise;
  await app.shutdown();
}

main().catch(e => {
  console.error("Simulation failed:", e.message);
  process.exit(1);
});