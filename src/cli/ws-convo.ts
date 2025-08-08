import { parseArgs } from "./cli-utils/parseArgs";
import { wsRpcCall } from "./cli-utils/wsRpcCall";
import { WsTransport } from "$src/agents/runtime/ws.transport";
import { WsEvents } from "$src/agents/runtime/ws.events";
import { EchoAgent } from "$src/agents/echo.agent";

const argv = parseArgs();

async function main() {
  let conversationId: number;

  if (argv.create) {
    const agents = [
      {
        id: argv["agent-id"],
        kind: "external" as const,  // Mark as external since we're connecting via WebSocket
        agentClass: argv["agent-class"] || "EchoAgent",
        config: argv["agent-config"] ? JSON.parse(argv["agent-config"] as string) : {},
      }
    ];

    // Unless --solo or policy is single-agent-loop, add a dummy partner
    const policy = argv.policy || "strict-alternation";
    if (!argv.solo && policy === "strict-alternation") {
      agents.push({
        id: "dummy-bot",
        kind: "external" as const,
        agentClass: "EchoAgent",
        config: {}
      });
      console.log("ℹ️ Added dummy-bot for alternation policy");
    }

    const createPayload: any = {
      title: argv.title || "CLI Conversation",
      agents,
      config: { policy },
      startingAgentId: argv["agent-id"],
    };

    const { conversationId: newId } = await wsRpcCall<{ conversationId: number }>(
      argv.url,
      "createConversation",
      createPayload
    );

    conversationId = newId;
    console.log(`✅ Created conversation ${conversationId}`);

    if (argv["initial-message"]) {
      await wsRpcCall(argv.url, "sendMessage", {
        conversationId,
        agentId: argv["agent-id"],
        messagePayload: { text: argv["initial-message"] },
        finality: "turn",
      });
      console.log(`💬 Sent initial message: "${argv["initial-message"]}"`);
    }
  } else {
    if (!argv["conversation-id"]) {
      throw new Error("Must pass --create or --conversation-id");
    }
    conversationId = Number(argv["conversation-id"]);
  }

  // Create transport and events for external agent
  const transport = new WsTransport(argv.url);
  const events = new WsEvents(argv.url, {
    conversationId,
    includeGuidance: true
  });
  
  const agentImpl = new EchoAgent(transport, events, `${argv["agent-id"]} is thinking...`, "Done");

  console.log(
    `🤖 Joining conversation ${conversationId} as ${argv["agent-id"]} (${agentImpl.constructor.name})`
  );

  await agentImpl.start(conversationId, argv["agent-id"]);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
