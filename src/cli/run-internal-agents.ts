#!/usr/bin/env bun

/**
 * This script demonstrates how to run internal agents for a conversation.
 * Internal agents need to be explicitly started - they don't run automatically
 * when a conversation is created with kind: "internal" agents.
 */

import { App } from "../server/app";
import { BaseAgent } from "../agents/runtime/base-agent";
import { InProcessTransport } from "../agents/runtime/inprocess.transport";
import { InProcessEvents } from "../agents/runtime/inprocess.events";
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

  console.log(`📋 Starting internal agents for conversation ${conversationId}: "${convo.metadata.title || 'Untitled'}"`);
  
  const agents: BaseAgent[] = [];
  
  // Start an agent for each agent that has an agentClass (indicating it should run internally)
  for (const agent of convo.metadata.agents) {
    if (!agent.agentClass) {
      console.log(`⏭️  Skipping ${agent.id} (no agentClass specified)`);
      continue;
    }
    
    console.log(`🤖 Starting ${agent.id} (${agent.agentClass || "default"})`);
    
    // Create transport and events for this agent
    const transport = new InProcessTransport(app.orchestrator);
    const events = new InProcessEvents(app.orchestrator, conversationId, true);
    
    // Create the agent implementation based on agentClass
    let agentImpl: BaseAgent;
    const agentClass = (agent.agentClass || "EchoAgent").toLowerCase();
    
    if (agentClass === "echoagent") {
      agentImpl = new EchoAgent(
        transport,
        `${agent.id} is thinking...`,
        `Hello from ${agent.id}!`
      );
    } else if (agentClass === "assistantagent") {
      const provider = app.llmProviderManager.getProvider();
      agentImpl = new AssistantAgent(transport, provider);
    } else {
      // Default to echo agent
      agentImpl = new EchoAgent(transport);
    }
    
    // Start the agent
    agents.push(agentImpl);
    agentImpl.start(conversationId, agent.id).catch(err => {
      console.error(`❌ Error in ${agent.id}:`, err);
    });
  }
  
  if (agents.length === 0) {
    console.log("⚠️  No internal agents found in this conversation");
    await app.shutdown();
    return;
  }
  
  console.log(`✅ Started ${agents.length} internal agent(s)`);
  console.log("Press Ctrl+C to stop...");
  
  // Handle shutdown
  process.on("SIGINT", async () => {
    console.log("\n🛑 Stopping agents...");
    for (const agent of agents) {
      agent.stop();
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