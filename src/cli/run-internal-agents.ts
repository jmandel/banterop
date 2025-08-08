#!/usr/bin/env bun

/**
 * This script demonstrates how to run internal agents for a conversation.
 * Internal agents need to be explicitly started - they don't run automatically
 * when a conversation is created with kind: "internal" agents.
 */

import { App } from "../server/app";
import { TurnLoopExecutorInternal } from "../agents/executors/turn-loop-executor.internal";
import { EchoAgent } from "../agents/echo.agent";
import { AssistantAgent } from "../agents/assistant.agent";

async function main() {
  // Create the app instance (connects to same DB as server)
  const app = new App();
  
  // Check command line args
  const conversationId = parseInt(process.argv[2] || "");
  if (!conversationId) {
    console.error("Usage: bun run src/cli/run-internal-agents.ts <conversationId>");
    console.error("");
    console.error("First create a conversation with internal agents using:");
    console.error("  bun run src/cli/ws-internal-agents.ts");
    console.error("Then run this script with the conversation ID to start the agents.");
    process.exit(1);
  }

  // Get conversation metadata
  const convo = app.orchestrator.getConversationWithMetadata(conversationId);
  if (!convo) {
    console.error(`Conversation ${conversationId} not found`);
    process.exit(1);
  }

  console.log(`📋 Starting internal agents for conversation ${conversationId}: "${convo.title}"`);
  
  const loops: TurnLoopExecutorInternal[] = [];
  
  // Start an executor for each internal agent
  for (const agent of convo.metadata.agents) {
    if (agent.kind !== "internal") {
      console.log(`⏭️  Skipping ${agent.id} (${agent.kind} agent)`);
      continue;
    }
    
    console.log(`🤖 Starting ${agent.id} (${agent.agentClass || "default"})`);
    
    // Create the agent implementation based on agentClass
    let agentImpl;
    const agentClass = (agent.agentClass || "EchoAgent").toLowerCase();
    
    if (agentClass === "echoagent") {
      agentImpl = new EchoAgent(
        `${agent.id} is thinking...`,
        `Hello from ${agent.id}!`
      );
    } else if (agentClass === "assistantagent") {
      const provider = app.providerManager.getProvider();
      agentImpl = new AssistantAgent(provider);
    } else {
      // Default to echo agent
      agentImpl = new EchoAgent();
    }
    
    // Create and start the executor
    const loop = new TurnLoopExecutorInternal(
      app.orchestrator,
      {
        conversationId,
        agentId: agent.id,
        meta: agent,
        buildAgent: () => agentImpl,  // For backward compatibility
      }
    );
    
    loops.push(loop);
    loop.start().catch(err => {
      console.error(`❌ Error in ${agent.id}:`, err);
    });
  }
  
  if (loops.length === 0) {
    console.log("⚠️  No internal agents found in this conversation");
    await app.shutdown();
    return;
  }
  
  console.log(`✅ Started ${loops.length} internal agent(s)`);
  console.log("Press Ctrl+C to stop...");
  
  // Handle shutdown
  process.on("SIGINT", async () => {
    console.log("\n🛑 Stopping agents...");
    for (const loop of loops) {
      loop.stop();
    }
    await app.shutdown();
    process.exit(0);
  });
  
  // Keep the process alive
  await new Promise(() => {});
}

main().catch(err => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});