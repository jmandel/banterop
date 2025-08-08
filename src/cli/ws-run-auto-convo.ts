#!/usr/bin/env bun
import { wsRpcCall } from "./cli-utils/wsRpcCall";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const argv = yargs(hideBin(process.argv))
  .option("url", {
    describe: "WebSocket URL of orchestrator",
    type: "string",
    default: "ws://localhost:3000/api/ws",
  })
  .option("title", {
    describe: "Conversation title",
    type: "string",
    default: "AutoRun Conversation",
  })
  .option("agent1-id", {
    describe: "First agent ID",
    type: "string",
    default: "alpha",
  })
  .option("agent1-class", {
    describe: "First agent class",
    type: "string",
    default: "EchoAgent",
  })
  .option("agent2-id", {
    describe: "Second agent ID",
    type: "string",
    default: "beta",
  })
  .option("agent2-class", {
    describe: "Second agent class",
    type: "string",
    default: "EchoAgent",
  })
  .option("max-turns", {
    describe: "Maximum number of turns before ending conversation",
    type: "number",
    default: 6,
  })
  .option("policy", {
    describe: "Policy type",
    type: "string",
    default: "strict-alternation",
  })
  .help()
  .parseSync();

async function main() {
  const wsUrl = argv.url;

  // 1. Create a simple scenario for the agents
  const scenarioId = `auto-scenario-${Date.now()}`;
  await wsRpcCall(wsUrl, "createScenario", {
    id: scenarioId,
    name: "Auto-run Scenario",
    config: {
      metadata: {
        id: scenarioId,
        title: "Auto-run Scenario",
        description: "Simple scenario for auto-run conversations"
      },
      scenario: {
        background: "Two agents having a conversation",
        challenges: ["Complete the conversation successfully"]
      },
      agents: [
        {
          agentId: argv.agent1Id,
          principal: {
            type: "individual",
            name: argv.agent1Id,
            description: `${argv.agent1Id} agent`
          },
          situation: "Ready to start a conversation",
          systemPrompt: `You are ${argv.agent1Id}. Engage in a brief conversation. After 3-4 exchanges, end the conversation politely.`,
          goals: ["Have a brief conversation", "End gracefully"],
          tools: [],
          knowledgeBase: {}
        },
        {
          agentId: argv.agent2Id,
          principal: {
            type: "individual",
            name: argv.agent2Id,
            description: `${argv.agent2Id} agent`
          },
          situation: "Ready to respond in a conversation",
          systemPrompt: `You are ${argv.agent2Id}. Respond briefly and politely. After 3-4 exchanges, agree to end the conversation.`,
          goals: ["Respond appropriately", "End gracefully"],
          tools: [],
          knowledgeBase: {}
        }
      ]
    }
  });
  console.log(`📋 Created scenario ${scenarioId}`);

  // 2. Create conversation with the scenario
  const { conversationId } = await wsRpcCall<{ conversationId: number }>(
    wsUrl,
    "createConversation",
    {
      title: argv.title,
      scenarioId: scenarioId,
      agents: [
        { id: argv.agent1Id, kind: "internal", agentClass: argv.agent1Class },
        { id: argv.agent2Id, kind: "internal", agentClass: argv.agent2Class },
      ],
      config: { policy: argv.policy }
    }
  );
  console.log(`✅ Created conversation ${conversationId}`);

  // 3. Mark it for autoRun and start loops
  const result = await wsRpcCall(wsUrl, "runConversationToCompletion", { conversationId });
  if ((result as any).started) {
    console.log(`▶️ Conversation ${conversationId} running to completion (will survive restart)`);
  }

  // 4. Send an initial message to kick off the conversation
  await wsRpcCall(wsUrl, "sendMessage", {
    conversationId,
    agentId: "system",
    messagePayload: { text: "Please begin the conversation" },
    finality: "turn"
  });
  console.log(`🚀 Sent initial message to start conversation ${conversationId}`);
  
  // 5. Monitor conversation and end it after max turns
  if (argv.maxTurns > 0) {
    console.log(`⏳ Will end conversation after ${argv.maxTurns} turns...`);
    
    // Subscribe to monitor events
    const ws = new WebSocket(wsUrl);
    let turnCount = 0;
    
    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: "sub1",
          method: "subscribe",
          params: { conversationId, includeGuidance: false }
        }));
      };
      
      ws.onmessage = async (evt) => {
        const msg = JSON.parse(evt.data.toString());
        if (msg.method === "event" && msg.params?.type === "message" && msg.params?.finality === "turn") {
          turnCount++;
          console.log(`   Turn ${turnCount}/${argv.maxTurns} completed by ${msg.params.agentId}`);
          
          if (turnCount >= argv.maxTurns) {
            console.log(`🛑 Ending conversation after ${turnCount} turns`);
            await wsRpcCall(wsUrl, "sendMessage", {
              conversationId,
              agentId: "system",
              messagePayload: { text: `Conversation ended after ${turnCount} turns` },
              finality: "conversation"
            });
            ws.close();
            resolve();
          }
        }
        
        if (msg.params?.finality === "conversation") {
          console.log(`✅ Conversation ${conversationId} completed`);
          ws.close();
          resolve();
        }
      };
    });
  }
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});