#!/usr/bin/env bun
import fs from "fs";
import { TurnLoopExecutorExternal } from "$src/agents/executors/turn-loop-executor.external";
import { EchoAgent } from "$src/agents/echo.agent";
import { AssistantAgent } from "$src/agents/assistant.agent";
import { wsRpcCall } from "./cli-utils/wsRpcCall";
import { parseArgs } from "./cli-utils/parseArgs";
import { MockLLMProvider } from "$src/llm/providers/mock";

const argv = parseArgs();

async function main() {
  if (argv["create-scenario"]) {
    const scenarioData = JSON.parse(fs.readFileSync(argv["create-scenario"], "utf-8"));
    if (!argv["scenario-id"]) argv["scenario-id"] = scenarioData.metadata.id;
    await wsRpcCall(argv.url, "createScenario", {
      id: argv["scenario-id"],
      name: scenarioData.metadata.title,
      config: scenarioData,
    });
    console.log(`✅ Registered scenario ${argv["scenario-id"]}`);
  }

  if (!argv["scenario-id"]) {
    throw new Error("Scenario ID is required for ws-scenario");
  }

  const { conversationId } = await wsRpcCall<{ conversationId: number }>(
    argv.url,
    "createConversation",
    {
      scenarioId: argv["scenario-id"],
      title: argv.title || `Scenario Run: ${argv["scenario-id"]}`,
      startingAgentId: argv["starting-agent-id"],
      agents: [
        { id: argv["agent-id"], kind: "internal" },
        { id: "user", kind: "external" },
      ],
      config: { policy: "strict-alternation" },
    }
  );

  console.log(`✅ Conversation ${conversationId} created from scenario`);

  const agentImpl =
    argv["agent-class"] === "AssistantAgent"
      ? new AssistantAgent(new MockLLMProvider({ provider: 'mock' }))
      : new EchoAgent("Thinking...", "Done");

  const exec = new TurnLoopExecutorExternal(agentImpl, {
    conversationId,
    agentId: argv["agent-id"],
    wsUrl: argv.url,
  });

  await exec.start();
  console.log("🏁 Scenario conversation ended");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});