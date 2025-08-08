# 💬 Conversational Interop Reference Stack

A transparent, extensible simulation and orchestration environment for **conversation‑driven interoperability**.

This is the official **reference backend** for the HL7 FHIR Connectathon **Language‑First Interoperability (LFI)** Track — a proving ground for AI‑mediated, scenario‑based interactions between agents in healthcare and beyond.

---

## 🌍 Background & Motivation

### The Shift to Conversational Interoperability

Healthcare and other complex industries are moving from **rigid, predefined APIs** toward **fluid, context‑aware, natural‑language exchanges** between participants. This is driven by:

- **LLM‑powered reasoning** — Agents can negotiate, clarify, and coordinate without every branch pre‑coded
- **Dynamic business logic** — Many rules and edge cases cannot be fully captured in static request/response contracts
- **Reduced integration friction** — Use conversation itself as the interoperability layer, reducing brittle point‑to‑point mappings

**Language‑First Interoperability (LFI)** imagines organizations, systems, and humans communicating via **agents** that “just talk” — asking clarifying questions, exchanging structured + unstructured information, and jointly solving problems.

---

## 🎯 Goals of This Reference Stack

1. **Glass‑box reference environment**: Run full simulated conversations with internal (or external) agents, seeing every decision, trace, tool call, and message in real time.
2. **Robust orchestration layer**: Coordinate multi‑agent exchanges with turn‑taking, scheduling policies, and message routing.
3. **Interop‑friendly**: Plug in agents using **standard protocols** like MCP (Model Context Protocol) now, A2A (Agent‑to‑Agent) async later — without custom glue.
4. **Executable spec**: Type‑safe, database‑backed, thoroughly tested code illustrating best practices for conversational orchestration.
5. **Scenario‑driven simulations**: Pre‑define realistic situations, goals, and tools; run repeatable tests.

---

## 🛠 Key Features

- **Scenario Builder & Runtime** — `ScenarioConfiguration` defines personas, private knowledge bases, tools, and world background.
- **Fully‑logged Event Stream** — Append‑only storage of all events: messages, traces, system signals, attachments.
- **Hydration API** — Merge static scenario + runtime metadata for agent initialization.
- **Internal & External Agents**:
  - Built‑in internal implementations: `ScenarioDrivenAgent`, `AssistantAgent`, `EchoAgent`, scripted agents
  - Remote agents connect via WebSocket JSON‑RPC
- **Turn Claiming & Guidance** — Orchestrator signals whose turn it is and enforces claim/expiry to prevent racing.
- **Attachment Management** — Store and reference rich content (replace inline content with database refs).
- **Transparent Scheduling** — Swappable policies: simple alternation, scenario‑aware, competition mode for load tests.
- **Developer CLIs** — One‑shot scripts in `src/cli` for demos, simulations, and agent integration examples.

---

## ⚙️ Architecture Overview

```
┌──────────────────┐
│  Scenario Layer   │
│  (Definitions)    │
└─────────┬─────────┘
          │ references
┌─────────▼─────────┐
│  Orchestration    │
│  (OrchestratorSvc)│
└───┬───────────┬───┘
    │events     │guidance
┌───▼───┐   ┌───▼─────┐
│Events │   │Subscript│
│Store  │   │Bus      │
└───────┘   └───────┬─┘
                    │
         ┌──────────▼───────────┐
         │ Agent Layer          │
         │ internal / external  │
         └──────────┬───────────┘
                    │ WebSocket JSON‑RPC / MCP / A2A (future)
             ┌──────▼──────┐
             │ External    │
             │ Agent       │
             └─────────────┘
```

---

### **1. Scenario Layer**
- Stored as JSON in `ScenarioStore` (`scenarios` table).
- Defines:
  - Agents: ID, persona, goals, tools
  - Each agent’s **private knowledgeBase** (for tool execution)
  - Shared `background` and `challenges`

### **2. Orchestration Layer**
- `OrchestratorService`:
  - Appends events via `EventStore`
  - Publishes to subscribers
  - Runs **scheduling policies** to pick the next agent
  - Emits **guidance events** (ephemeral signals: “Agent X should act next”)
  - Manages **turn claims** to avoid duplicate acting

### **3. Persistence Layer**
- `schema.sql.ts` defines normalized tables:
  - `conversations`, `conversation_events`, `attachments`, `scenarios`, `turn_claims`, `idempotency_keys`
- All events stored chronologically with **finality** (`none`, `turn`, `conversation`).

### **4. Agent Layer**
- **Internal agents** implement `Agent.handleTurn(ctx)`:
  - `ScenarioDrivenAgent` — Synthesizes persona/system prompt from scenario + history
  - `AssistantAgent` — Minimalistic user/assistant prompt
  - `EchoAgent` — For testing message flow
- **Execution Loops**:
  - `InternalTurnLoop`: uses in‑process `OrchestratorService`
  - `TurnLoopExecutor`: connects over WS JSON‑RPC

### **5. Integration / Bridge Layer**
- **WS JSON‑RPC (`/api/ws`)**:
  - Subscribe to events/guidance
  - Send messages/traces
  - Claim turns
- **REST API**:
  - Manage scenarios
  - Fetch/download attachments
- **MCP Bridge**:
  - Wraps a conversation with `begin_chat_thread`, `send_message_to_chat_thread`, `wait_for_reply`
- **Future A2A**:
  - Event‑driven pub/sub between peer orchestrators & agents

---

## 🔌 Protocol Support

- **MCP (Model Context Protocol)**  
  For Connectathon participant agents wanting a synchronous tool‑call UX.
  
- **A2A (Agent‑to‑Agent)** *(Planned)*  
  Asynchronous, bidirectional agent messaging for richer workflows.

---

## 📂 Project Structure

```
src/
  agents/         # Implementations, executors, factories
  cli/            # Demo scripts
  db/             # SQLite schema, store classes
  llm/            # Provider integrations (Google, OpenRouter, Mock)
  lib/            # Utility modules
  server/         # Hono server, orchestrator, routes
  types/          # Shared type definitions
tests/            # Unit & integration tests
```

---

## 🚀 Running Locally

1. **Install dependencies**  
   ```bash
   bun install
   ```

2. **Run in dev mode**  
   ```bash
   bun run dev
   ```

3. **Try a CLI demo**  
   ```bash
   bun run src/cli/run-sim-inproc.ts
   ```

---

## 📡 Example: External Agent via WebSocket JSON‑RPC

```ts
const ws = new WebSocket('ws://localhost:3000/api/ws');

ws.onopen = () => {
  ws.send(JSON.stringify({
    id: 'sub',
    method: 'subscribe',
    params: { conversationId: 1, includeGuidance: true }
  }));
};

ws.onmessage = (evt) => {
  const msg = JSON.parse(evt.data);
  if (msg.method === 'guidance') {
    // claimTurn then sendMessage
  }
};
```

---

## 🔮 Next Steps (Roadmap)

1. **Frontend Conversation Inspector** — real‑time multi‑pane (conversation + per‑agent traces).
2. **Scenario Builder UI** — create/edit scenarios collaboratively.
3. **A2A Bridge** — robust async interoperability beyond strict alternation.
4. **Tool Synthesis Oracle** — complete `ToolSynthesisService` for omniscient scenario‑based tool exec.
5. **Automatic Conversation Resurrection** — bring back active conversations post‑restart.
6. **Human‑in‑Loop Hooks** — let agents pause for principal input.
7. **Scenario Evaluation Metrics** — auto‑classify success/failure turns.

---

**HL7 FHIR Connectathon LFI Track** participants can deploy this stack locally or extend it to prototype **their own agents** interacting over **standard interop protocols** — with full transparency into orchestration, decisioning, and conversation flow.
