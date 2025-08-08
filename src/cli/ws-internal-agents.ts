#!/usr/bin/env bun

import { parseArgs } from "./cli-utils/parseArgs";
import { wsRpcCall } from "./cli-utils/wsRpcCall";

const argv = parseArgs();

async function main() {
  const wsUrl = argv.url || "ws://localhost:3000/api/ws";
  
  // Create a conversation with two internal agents that should be managed by the orchestrator
  const agents = [
    {
      id: argv["agent-id"] || "agent-alpha",
      kind: "internal" as const,
      agentClass: "EchoAgent",
      config: {},
    },
    {
      id: "agent-beta",
      kind: "internal" as const,
      agentClass: "EchoAgent",
      config: {},
    }
  ];

  const createPayload: any = {
    title: argv.title || "Internal Agents Test",
    agents,
    config: { policy: "strict-alternation" },
    startingAgentId: agents[0]?.id,
  };

  console.log("📝 Creating conversation with internal agents:", agents.map(a => a.id).join(", "));
  
  const { conversationId } = await wsRpcCall<{ conversationId: number }>(
    wsUrl,
    "createConversation",
    createPayload
  );

  console.log(`✅ Created conversation ${conversationId}`);
  
  // Send an initial message to kick off the conversation
  if (argv["initial-message"] || !argv["no-kickoff"]) {
    const message = argv["initial-message"] || "Hello from the test!";
    console.log(`💬 Sending kickoff message: "${message}"`);
    
    await wsRpcCall(wsUrl, "sendMessage", {
      conversationId,
      agentId: "user",
      messagePayload: { text: message },
      finality: "turn",
    });
  }

  // Subscribe to watch events
  console.log("👀 Subscribing to conversation events...");
  
  const ws = new WebSocket(wsUrl);
  
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: "sub1",
        method: "subscribe",
        params: { conversationId, includeGuidance: true }
      }));
    };

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string);
      
      // Handle subscription response
      if (msg.id === "sub1" && msg.result?.subId) {
        console.log(`✅ Subscribed with ID: ${msg.result.subId}`);
        return;
      }
      
      // Handle event notifications
      if (msg.method === "event") {
        const event = msg.params;
        if (event.type === "message") {
          console.log(`[${event.agentId}] Message (turn ${event.turn}): ${event.payload?.text || JSON.stringify(event.payload)}`);
          
          if (event.finality === "conversation") {
            console.log("🏁 Conversation ended");
            ws.close();
            resolve();
          }
        } else if (event.type === "trace") {
          console.log(`[${event.agentId}] Trace: ${JSON.stringify(event.payload)}`);
        } else if (event.type === "system") {
          console.log(`[System] ${event.payload?.kind}: ${JSON.stringify(event.payload?.data)}`);
        }
      }
      
      // Handle guidance notifications
      if (msg.method === "guidance") {
        const guidance = msg.params;
        console.log(`🎯 Guidance for ${guidance.nextAgentId} (seq: ${guidance.seq})`);
      }
    };

    ws.onerror = (err) => {
      console.error("❌ WebSocket error:", err);
      reject(err);
    };
  });

  console.log("✨ Done!");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});