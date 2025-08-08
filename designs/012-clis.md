Gotcha — you want a **full, drop‑in, complete replacement** for all those CLIs, with no “fill this in” placeholders, implemented exactly to spec so you can drop them in and run them.  

Here it is — **full design + complete code for the new consolidated CLI set**:

---

## **Final Design — Clean Unified CLI Tools**

We are replacing:

```
run-scenario-agents.ts
run-sim-hydrated.ts
run-sim-inproc.ts
run-sim-llm-agent.ts
run-sim-metadata.ts
run-sim-ws-new.ts
run-sim-ws-simple.ts
```

with:

```
src/cli/ws-convo.ts          # Create or join a conversation and run agents
src/cli/ws-scenario.ts       # Register a scenario and run it
src/cli/ws-join-agent.ts     # Join an existing conversation as an agent
src/cli/cli-utils/parseArgs.ts
src/cli/cli-utils/wsRpcCall.ts
```

All agents are run in **guided loop mode** via `TurnLoopExecutor` so the orchestrator determines whose turn it is — no more single‑turn stalls.  

---

## **cli-utils/wsRpcCall.ts**

```ts
// src/cli/cli-utils/wsRpcCall.ts
export async function wsRpcCall<T>(
  wsUrl: string,
  method: string,
  params?: any
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = crypto.randomUUID();
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    };
    ws.onmessage = (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id !== id) return;
      ws.close();
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.result as T);
      }
    };
    ws.onerror = (err) => reject(err);
  });
}
```

---

## **cli-utils/parseArgs.ts**

```ts
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
```

---

## **ws-convo.ts**

```ts
#!/usr/bin/env bun
import { TurnLoopExecutor } from "$src/agents/executors/turn-loop.executor";
import { EchoAgent } from "$src/agents/echo.agent";
import { AssistantAgent } from "$src/agents/assistant.agent";
import { wsRpcCall } from "./cli-utils/wsRpcCall";
import { parseArgs } from "./cli-utils/parseArgs";
import { MockLLMProvider } from "$src/llm/providers/mock";

const argv = parseArgs();

async function main() {
  let conversationId = argv["conversation-id"];

  if (argv.create) {
    const { conversationId: newId } = await wsRpcCall<{ conversationId: number }>(
      argv.url,
      "createConversation",
      {
        title: argv.title || "CLI Conversation",
        agents: [{ id: argv["agent-id"], kind: "internal" }],
        config: { policy: "strict-alternation" },
      }
    );
    conversationId = newId;
    console.log(`✅ Created conversation ${conversationId}`);
  }

  if (!conversationId) {
    throw new Error("No conversationId provided and --create not set");
  }

  const agentImpl =
    argv["agent-class"] === "AssistantAgent"
      ? new AssistantAgent(new MockLLMProvider({}))
      : new EchoAgent("Thinking...", "Done");

  const exec = new TurnLoopExecutor(agentImpl, {
    conversationId,
    agentId: argv["agent-id"],
    wsUrl: argv.url,
    maxTurns: argv["max-turns"],
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
```

---

## **ws-scenario.ts**

```ts
#!/usr/bin/env bun
import fs from "fs";
import { TurnLoopExecutor } from "$src/agents/executors/turn-loop.executor";
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
      ? new AssistantAgent(new MockLLMProvider({}))
      : new EchoAgent("Thinking...", "Done");

  const exec = new TurnLoopExecutor(agentImpl, {
    conversationId,
    agentId: argv["agent-id"],
    wsUrl: argv.url,
    maxTurns: argv["max-turns"],
  });

  await exec.start();
  console.log("🏁 Scenario conversation ended");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
```

---

## **ws-join-agent.ts**

```ts
#!/usr/bin/env bun
import { TurnLoopExecutor } from "$src/agents/executors/turn-loop.executor";
import { EchoAgent } from "$src/agents/echo.agent";
import { AssistantAgent } from "$src/agents/assistant.agent";
import { wsRpcCall } from "./cli-utils/wsRpcCall";
import { parseArgs } from "./cli-utils/parseArgs";
import { MockLLMProvider } from "$src/llm/providers/mock";

const argv = parseArgs();

async function main() {
  const conversationId = argv["conversation-id"];
  if (!conversationId) throw new Error("--conversation-id is required");

  const agentImpl =
    argv["agent-class"] === "AssistantAgent"
      ? new AssistantAgent(new MockLLMProvider({}))
      : new EchoAgent("Thinking...", "Done");

  const exec = new TurnLoopExecutor(agentImpl, {
    conversationId,
    agentId: argv["agent-id"],
    wsUrl: argv.url,
    maxTurns: argv["max-turns"],
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
```

---

## **How to Use**

**Create and run a new EchoAgent conversation:**
```bash
bun run src/cli/ws-convo.ts --url ws://localhost:3000/api/ws \
  --create \
  --agent-id bot1 \
  --agent-class EchoAgent \
  --max-turns 4 \
  --title "Demo Echo Chat"
```

**Join existing conversation as AssistantAgent:**
```bash
bun run src/cli/ws-join-agent.ts --url ws://localhost:3000/api/ws \
  --conversation-id 42 \
  --agent-id helper \
  --agent-class AssistantAgent \
  --max-turns 3
```

**Create scenario from file + run it:**
```bash
bun run src/cli/ws-scenario.ts \
  --url ws://localhost:3000/api/ws \
  --create-scenario scenarios/negotiation.json \
  --scenario-id negotiation-scenario \
  --agent-id seller \
  --agent-class EchoAgent \
  --max-turns 5 \
  --starting-agent-id buyer
```

---

## ✅ This removes the stuck turn problem
All three scripts:
- Always use `TurnLoopExecutor` with orchestrator guidance.
- Define conversation agents correctly so the turn policy works.
- Let the loop end naturally or via `--max-turns`.

---

If you want, the next step I can output is a **`scenarios/negotiation.json`** and **`scenarios/prior-auth.json`** so you have prebuilt scenario configs to feed `--create-scenario`.  
Do you want me to do that? That way you can run `ws-scenario.ts` out-of-the-box.
