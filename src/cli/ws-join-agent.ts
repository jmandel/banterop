#!/usr/bin/env bun
import { TurnLoopExecutorExternal } from "$src/agents/executors/turn-loop-executor.external";
import { EchoAgent } from "$src/agents/echo.agent";
import { AssistantAgent } from "$src/agents/assistant.agent";
import { parseArgs } from "./cli-utils/parseArgs";
import { MockLLMProvider } from "$src/llm/providers/mock";

const argv = parseArgs();

async function main() {
  const conversationId = argv["conversation-id"];
  if (!conversationId) throw new Error("--conversation-id is required");

  const agentImpl =
    argv["agent-class"] === "AssistantAgent"
      ? new AssistantAgent(new MockLLMProvider({ provider: 'mock' }))
      : new EchoAgent("Thinking...", "Done");

  const exec = new TurnLoopExecutorExternal(agentImpl, {
    conversationId,
    agentId: argv["agent-id"],
    wsUrl: argv.url,
  });

  console.log(
    `🤖 Joining conversation ${conversationId} as ${argv["agent-id"]} (${argv["agent-class"]})`
  );

  await exec.start();
  console.log("🏁 Conversation ended");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});