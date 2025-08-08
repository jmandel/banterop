import { parseArgs } from "./cli-utils/parseArgs";
import { wsRpcCall } from "./cli-utils/wsRpcCall";
import { TurnLoopExecutorExternal } from "$src/agents/executors/turn-loop-executor.external";
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
        config: argv["agent-config"] ? JSON.parse(argv["agent-config"]) : {},
      }
    ];

    // Unless --solo or policy is single-agent-loop, add a dummy partner
    const policy = argv.policy || "strict-alternation";
    if (!argv.solo && policy === "strict-alternation") {
      agents.push({
        id: "dummy-bot",
        kind: "internal",
        agentClass: "EchoAgent",
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
    conversationId = parseInt(argv["conversation-id"]);
  }

  const agentImpl = new EchoAgent({ name: argv["agent-id"] });

  console.log(
    `🤖 Joining conversation ${conversationId} as ${argv["agent-id"]} (${agentImpl.constructor.name})`
  );

  const executor = new TurnLoopExecutorExternal(agentImpl, {
    conversationId,
    agentId: argv["agent-id"],
    wsUrl: argv.url,
    maxTurns: argv["max-turns"] ? parseInt(argv["max-turns"]) : undefined,
  });

  await executor.start();
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
