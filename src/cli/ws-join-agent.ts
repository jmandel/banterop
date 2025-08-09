#!/usr/bin/env bun
import { BaseAgent } from "$src/agents/runtime/base-agent";
import { WsTransport } from "$src/agents/runtime/ws.transport";
import { WsEvents } from "$src/agents/runtime/ws.events";
import { EchoAgent } from "$src/agents/echo.agent";
import { AssistantAgent } from "$src/agents/assistant.agent";
import { parseArgs } from "./cli-utils/parseArgs";
import { MockLLMProvider } from "$src/llm/providers/mock";

const argv = parseArgs();

async function main() {
  const conversationId = Number(argv["conversation-id"]);
  if (!conversationId) throw new Error("--conversation-id is required");

  // Create transport and events for external agent
  const transport = new WsTransport(argv.url);
  const events = new WsEvents(argv.url, {
    conversationId,
    includeGuidance: true
  });

  const agentImpl: BaseAgent =
    argv["agent-class"] === "AssistantAgent"
      ? new AssistantAgent(transport, new MockLLMProvider({ provider: 'mock' }))
      : new EchoAgent(transport, "Thinking...", "Done");

  console.log(
    `🤖 Joining conversation ${conversationId} as ${argv["agent-id"]} (${argv["agent-class"]})`
  );

  await agentImpl.start(conversationId, argv["agent-id"]);
  console.log("🏁 Conversation ended");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});