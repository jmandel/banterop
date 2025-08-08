// src/cli/cli-utils/parseArgs.ts
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

export function parseArgs() {
  return yargs(hideBin(process.argv))
    .option("url", {
      describe: "WebSocket URL of orchestrator",
      type: "string",
      default: "ws://localhost:3000/api/ws",
    })
    .option("conversation-id", {
      describe: "Join an existing conversation by ID",
      type: "number",
    })
    .option("agent-id", {
      describe: "Agent ID",
      type: "string",
      demandOption: true,
    })
    .option("agent-class", {
      describe: "Agent class to run (EchoAgent or AssistantAgent)",
      type: "string",
      choices: ["EchoAgent", "AssistantAgent"],
      default: "EchoAgent",
    })
    .option("max-turns", {
      describe: "Maximum turns before ending conversation",
      type: "number",
      default: 5,
    })
    .option("title", {
      describe: "Conversation title (when creating)",
      type: "string",
    })
    .option("create", {
      describe: "Create new conversation before joining",
      type: "boolean",
      default: false,
    })
    .option("scenario-id", {
      describe: "Scenario ID to use",
      type: "string",
    })
    .option("create-scenario", {
      describe: "Path to scenario JSON to register",
      type: "string",
    })
    .option("starting-agent-id", {
      describe: "Which agent starts the conversation",
      type: "string",
    })
    .help()
    .parseSync();
}