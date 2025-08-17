# 💬 Conversational Interop Reference Stack

This project provides a transparent, extensible simulation and orchestration environment designed to solve complex, cross-organization workflows by enabling autonomous AI agents to **"just talk"**.

Instead of relying on rigid, pre-defined APIs, agents on this platform communicate through a sequence of conversational turns, sharing data and negotiating outcomes dynamically. It's built to model and solve real-world challenges like prior authorizations, specialist appointment booking, or clinical trial matching, where context and negotiation are key.

---

## 💡 What This Stack Lets You Do

This reference stack is a "neutral ground" where **any developer** can plug in their own conversational agent and have it interact with other agents in **nearly any scenario you can design**.

We provide:

- **Configurable scenarios**: define the “world” — roles, goals, private records, and actions (“tools”) for each agent.
- **Tool synthesis** (“the Oracle”): produces believable results from those tools without real backend APIs.
- **Transparent orchestration**: your agent just sees messages, turns, and tool responses like it would with a real counterparty.

Your agent **never needs to know it’s in a simulation** — conversations look real from its perspective.

You can connect in multiple ways:

- **External MCP client** — Your agent connects *to* the orchestrator.
- **External MCP server** — The orchestrator connects to *your* agent.
- **External A2A clients & servers** — For emerging agent‑to‑agent protocol standards.
- **Or none at all** — run built‑in **improv agents** and simply watch them talk.

---

## 🌍 Background & Motivation

In many cross‑organization workflows, information exchange fails not for lack of transport, but because:

- **Integrations are brittle** — workflows break when business rules or local assumptions change.
- **Key context is missing** — data is structurally valid but incomplete for the receiver's purpose.
- **Humans fill the gaps** — requiring calls, emails, or faxes to clarify.

**Examples where conversation helps**:
- **Prior authorization** — Not just “yes/no”, but clarifying criteria, providing supporting documents.
- **Specialty appointment booking** — Not just finding a date, but confirming eligibility for a slot.
- **Clinical trial enrollment** — Determining eligibility through back‑and‑forth Q&A.
- **Disease registry reporting** — Negotiating missing or ambiguous case details.

### Conversation-Driven Exchange

Here, autonomous or semi‑autonomous **agents** act for each party.  
The conversation — natural language plus optional structured data attachments — works like an **email chain** the parties stay “in” until they work things out.

This stack makes it practical and testable:

- **Glass‑box runs** where you see every message, thought, simulated action.
- **Scenario‑based control** over context, roles, and rules.

---

## 🚀 Quick Start

```bash
# Install dependencies
bun install

# Start the server
bun run dev

# Run a demo (in another terminal)
bun run src/cli/demo-browserside-scenario.ts
```

## 🧭 Control vs Data Plane

This codebase cleanly separates how agents are managed (control plane) from how they talk (data plane).

- Control plane: start/stop and inspect agents and conversations
  - In-process: `InProcessControl` (server only)
  - WebSocket: `WsControl` (stateless, one-shot calls)
  - Methods: `createConversation`, `getConversation`, `lifecycle.getEnsured`, `lifecycle.ensure`, `lifecycle.stop`

- Data plane: agents exchange events through the orchestrator
  - In-process transport: `InProcessTransport`
  - WebSocket transport: `WsTransport`
  - Unified entry point for execution: `startAgents({ transport, providerManager, agentIds?, turnRecoveryMode: 'restart' })`

Minimal WS JSON-RPC (under `/api/ws`):
- Control: `createConversation`, `getConversation`, `lifecycle.getEnsured`, `lifecycle.ensure`, `lifecycle.stop`, `clearTurn`
- Data: `sendMessage`, `sendTrace`, `subscribe`, `unsubscribe`, `getEventsPage`

Scenario CRUD is HTTP-only under `/api/scenarios`; conversations list is HTTP under `/api/conversations`.

## 🚦 Launch Recipes

- Server-managed:
  - Control: `createConversation(meta)`, per-agent or bulk `lifecycleEnsure(conversationId, agentIds?)`
  - Inspect: `lifecycleGetEnsured(conversationId)` returns union of live host and persisted ensures
  - Observe: `subscribe` with optional `sinceSeq`, or poll `getEventsPage`
  - Resume: server persists ensures and re-ensures on boot

- Client-managed (browser):
  - Control: `createConversation(meta)` via WS
  - Data: use `BrowserAgentLifecycleManager` with `BrowserAgentHost` (WS transport)
  - Per-agent: `lifecycle.ensure(conversationId, [agentId])` to add agents incrementally
  - Resume: `lifecycle.resumeAll()` restores previously registered agents from `localStorage`
  - Isolation: `lifecycle.clearOthers(conversationId)` stops/unregisters browser agents for other conversations in this tab

See `src/cli/demo-browserside-scenario.ts` for a client-managed example.

---

## 🎯 Goals

1. **Glass‑box simulation** — See every decision, message, and tool call in context.
2. **Orderly orchestration** — Deterministic turn control and fair scheduling.
3. **Scenario‑driven testing** — Rich setups to test nuanced flows.
4. **Interop readiness** — MCP today, A2A tomorrow.
5. **Rapid prototyping** — Define an agent’s persona, private KB, and tools in minutes.

---

## 🛠 Key Features

- **Conversation**: Container for the whole exchange (like a shared email chain).
- **Scenario**: Playbook for a simulated world with roles & goals.
- **Tool Synthesis**: Oracle‑driven plausible action results.
- **Immutable Event Log**: Replayable record of all events.
- **Guidance Scheduling**: Orchestrator evaluates policy and emits guidance with kind: `start_turn` or `continue_turn`. Agents act only on guidance; no local alternation.
- **Attachment Handling**: Store/reuse large or structured artifacts.
- **Pluggable Scheduling**: Choose who speaks next.
- **CLI Demos**: Watch or run simulations locally.

---

## 🔍 Core Concepts

### 1. Conversations — *The session container*

**Concept:**  
A Conversation is the bounded “room” agents stay in until the job is done — like an email thread for coordination.

**Behavior:**
- **Roster** — IDs, type (internal/external), config.
- **Lifecycle** — Starts at turn 0, ends on explicit finality.
- **Scenario link** — Often tied to a scenario for simulation.

---


### 2. Scenarios — *Realistic improv setup*

**Concept:**  
Define structured starting conditions:
- Shared **background** and **challenges**.
- Distinct **roles** with identity, situation, goals, private KB, tools, and persona.
- Optional starter line.

Repeatable, comparable runs in the same “world”.

---


### 3. Tool Synthesis (“Oracle”)

Simulates tool/API calls:
- Input: Tool + params.
- Context: Scenario, KBs, history.
- Output: `{ reasoning, output }` plausible in-world.

---


### 4. Orchestrator

Keeps order:
- Evaluates scheduling policy (default: strict alternation) and emits `guidance` with a `kind`:
  - `start_turn`: begin the next turn (no open turn exists)
  - `continue_turn`: continue the currently open turn (owned by the target agent)
- Pushes guidance when it matters (conversation creation with starter, or when a `message` closes a turn).
- On subscribe with `includeGuidance=true`, pushes a one-shot guidance snapshot so agents know what to do immediately.
- Agents open or continue turns by posting a `message` or `trace`. Only `message` can close a turn (finality=`turn` or `conversation`).

---


### 5. Event Log

Immutable ledger:
- Types: Message / Trace / System.
- Addressing: turn, event, global `seq`.
- Finality: none / turn / conversation.

---


### 6. Attachments

Store large or structured content once, reference via `docId`.

---


### 7. Guidance & Turn Safety

The orchestrator is the single source of truth for scheduling. Guidance is policy output; agents do not infer policy.

- Guidance kinds:
  - `start_turn`: “Begin the next turn.” Emitted when there is no open turn (e.g., after a turn‑closing message or at conversation creation for the starter).
  - `continue_turn`: “Continue the open turn you own.” Emitted when a turn is open and owned by the target agent (e.g., on subscribe/reconnect).
- Push and pull:
  - Push: guidance is emitted at conversation creation (if `startingAgentId`) and when a message closes a turn.
  - Pull: `subscribe(..., includeGuidance=true)` yields a one‑shot guidance snapshot so agents can act immediately on startup/reconnect.
- Turn semantics:
  - Traces can open and continue a turn; only messages can close a turn.
  - Exactly one open non‑system turn exists at a time.
- Agent contract:
  - Act only on guidance (no local alternation). If `continue_turn` is received after a restart, agents may resume or explicitly `clearTurn` then start, based on their `turnRecoveryMode`.
  - Never act after finality=`conversation`.

---

## 📡 Clients & Data Patterns

**Connect as:**
- Participant (contribute turns)
- Observer (view only)

**Patterns:**
1. Snapshot + Follow — Fetch then live subscribe.
2. Continuous — Always-subscribe live.
3. Resilient — Resume after `seq` gap.

### Hydration

Before acting:
- Merge scenario data, live roster, and full event log into a single snapshot for your agent.

- System events live on a meta lane at turn `0` and do not block/close conversational turns `1..N`.

---

## 📊 Diagrams

### Concept Map
```mermaid
flowchart TB
    Scenario[Scenario\n- background, roles, KBs, tools]
    Conversation[Conversation Instance\n- roster, event log, config]
    ToolCall[Tool Call]
    Oracle[Oracle Synthesis\n(fictional but plausible outputs)]
    EventLog[Event Log]
    Hydration[Hydrated Snapshot\n(scenario + live state + events)]
    Agent[Agent / Client App\n(internal or external MCP/A2A)]

    Scenario --> Conversation
    Conversation --> ToolCall
    ToolCall --> Oracle --> EventLog
    Conversation --> EventLog
    EventLog --> Hydration --> Agent
    Conversation --> Hydration
```

---


### Turn Lifecycle
```mermaid
sequenceDiagram
    participant Orchestrator
    participant AgentA
    participant AgentB

    Orchestrator->>AgentA: guidance(nextAgentId)
    AgentA->>Orchestrator: message/trace (may open new turn)
    Orchestrator->>EventLog: append (message may set finality)
    Orchestrator->>AgentB: guidance(nextAgentId)
```

---


### Architecture Overview
```mermaid
flowchart LR
    subgraph ScenarioLayer[Scenario Layer]
        BG[Background & Challenges]
        Roles[Roles & Personas]
        KBs[Knowledge Bases]
        Tools[Tools & Guidance]
    end

    subgraph Runtime[Conversation Runtime]
        Orchestrator
        EventStore[(Event Store)]
        Guidance[Guidance Emitter]
    end

    ScenarioLayer --> Orchestrator
    Orchestrator --> EventStore
    Orchestrator --> Guidance

    subgraph Clients[Agents & External Clients]
        InternalAgents[Built-in Improv Agents]
        ExternalAgents[External MCP / A2A Agents]
    end

    Guidance --> Clients
    Clients --> Orchestrator
    EventStore --> Clients
```

---

## 📂 Project Structure

```
src/
  agents/         # Agent logic
  cli/            # CLI demos
  db/             # SQLite schema & accessors
  llm/            # LLM providers (mock & real)
  lib/            # Utilities
  server/         # Hono server, orchestrator, RPC
  frontend/       # Watch UI for local iteration
  types/          # Shared types
tests/            # Unit and integration tests
```

---

## 🚀 Running Locally

```bash
bun install
bun run dev              # API + WS (PORT or 3000)
```

Optional:
- `bun run dev:fullstack` — serves HTML routes at `/` and API at `/api` on one port
- `bun run dev:frontend` — serves watch UI at http://localhost:3001 (reads WS from 3000)
- `bun test` / `bun run test:watch` — run tests
- `bun run typecheck` — strict TypeScript checks
- `bun run clean` — remove local SQLite artifacts (`data.db*`)

Environment (.env; keys optional unless using non‑mock providers):
- `DB_PATH` — default `dbs/data.db` (auto-created directory)
- `PORT`, `IDLE_TURN_MS`
- `DEFAULT_LLM_MODEL` — e.g., `gemini-2.5-flash` or `openai/gpt-oss-120b:nitro`
- `DEFAULT_LLM_PROVIDER` — `google | openrouter | mock` (optional; defaults to `mock`)
- `GEMINI_API_KEY` (Google Gemini) and/or `OPENROUTER_API_KEY`
- Note: `DEFAULT_LLM_MODEL` alone works — provider is auto‑detected from the model name; if unknown, specify `DEFAULT_LLM_PROVIDER` explicitly.

Data defaults to `dbs/data.db` (gitignored) and the `dbs/` folder is created automatically when the DB opens.

Quick examples:
```bash
# Use a custom DB file under ./dbs
DB_PATH=dbs/my-run.db bun run dev

# Set default model only (provider auto-detected from model)
DEFAULT_LLM_MODEL=gemini-2.5-flash GEMINI_API_KEY=... bun run dev

# Explicit provider + model via OpenRouter
DEFAULT_LLM_PROVIDER=openrouter DEFAULT_LLM_MODEL=openai/gpt-oss-120b:nitro OPENROUTER_API_KEY=... bun run dev
```

### CLI Demos (working examples)

- Create/join a simple conversation as an external agent (Echo by default):
  ```bash
  bun run src/cli/ws-convo.ts --agent-id you --create --initial-message "Hello"
  ```
- Start two internal echo agents and watch events:
  ```bash
  bun run src/cli/ws-internal-agents.ts --agent-id agent-alpha --title "Internal Agents Test"
  ```
- Join an existing conversation:
  ```bash
  bun run src/cli/ws-join-agent.ts --conversation-id 1 --agent-id you --agent-class EchoAgent
  ```
- Run a scenario by ID (register one via HTTP or RPC first):
  ```bash
  bun run src/cli/ws-scenario.ts --scenario-id my-scenario --agent-id agent-1
  ```
- Auto‑run demo with resume:
  ```bash
  bun run src/cli/ws-run-auto-convo.ts --agent1-id alpha --agent2-id beta
  ```

All WS CLIs default to `ws://localhost:3000/api/ws`; override with `--url`.

### Watch UI

Lightweight watch/debug UI at `src/frontend/watch/`:

```bash
bun run dev   # serves all frontends at http://localhost:3000
```

#### Keyboard Shortcuts (Watch)

- j / k: Move selection down / up (list)
- Enter: Open selected conversation
- /: Focus list search
- h / l: Focus list / details
- r: Refresh list / reconnect details
- t: Toggle traces (details pane)
- a: Toggle autoscroll (details pane)
- ?: Toggle shortcuts help overlay

---

You can now:
- **Plug in your own agent** (MCP or A2A) as participant or observer.
- **Run ours** and watch believable, contextual conversations unfold.

---

## 🔌 HTTP API (summary)

- `GET /api/health`
- Scenarios (CRUD):
  - `GET /api/scenarios`
  - `GET /api/scenarios/:id`
  - `POST /api/scenarios`
  - `PUT /api/scenarios/:id`
  - `DELETE /api/scenarios/:id`
- Attachments:
  - `GET /api/attachments/:id` — metadata
  - `GET /api/attachments/:id/content` — raw content with `Content-Type`
- LLM helper:
  - `GET /api/llm/providers` — available providers
  - `POST /api/llm/complete` — synchronous completion (validates body)

## 🔗 WebSocket JSON‑RPC

Endpoint: `ws://<host>:<port>/api/ws`

Methods (subset):
- Health: `ping`
- Conversations: `createConversation`, `listConversations`, `getConversation`, `getHydratedConversation`, `getEventsPage`
- Events: `sendMessage`, `sendTrace`
- Subscriptions: `subscribe` (supports `filters.types`/`filters.agents` and `sinceSeq` backlog), `unsubscribe`, `subscribeAll`
- Scenarios: `listScenarios`, `getScenario`, `createScenario`, `updateScenario`, `deleteScenario`
- Orchestration helper: `runConversationToCompletion`
 - Lifecycle helpers (server): `lifecycle.getEnsured`, `lifecycle.ensure`, `lifecycle.stop`

Notifications:
- `event` — unified event
- `guidance` — scheduling hints with `kind: 'start_turn' | 'continue_turn'`

CAS: Turn validation is enforced server‑side. Clients typically do not need client‑side CAS beyond following guidance. Advanced clients may still use `lastClosedSeq` as a precaution when opening new turns.

## 🗂️ Data Model Notes

- Events use a global `seq` (monotone) and `ts` with millisecond precision.
- Only `message` events may set `finality` to `turn` or `conversation`; `trace`/`system` must use `none`.
- System events are stored on turn `0` and do not affect turn openness.
- Message attachments are persisted in an `attachments` table; payloads are rewritten to references `{ id, docId?, name, contentType, summary? }`.

## 🧭 Scheduling Policy

- Default policy: strict alternation over `metadata.agents`; emits guidance for the next agent when a turn‑ending message arrives.
- Scenario‑aware policies are available; scheduling is pluggable.

## 🔁 Automatic Conversation Resume

The orchestrator provides **automatic resume** for active conversations after server restarts, crashes, or deployments. This ensures high availability for ongoing agent interactions.

#### How It Works

When the server starts, it automatically discovers active conversations in the database (within a configurable lookback period). For each active conversation, the system:
1.  Recreates the conversation state in memory.
2.  Automatically recreates all server-managed agents.
3.  Subscribes the agents to all conversation events.
4.  Agents can then analyze the history and seamlessly continue the conversation from where it left off.

#### What Gets Resumed

-   ✅ **Automatically:** Server-managed internal agents, full conversation state (turns, traces), and event subscriptions.
-   ❌ **Must Reconnect Manually:** External agents (e.g., connecting via WebSocket or other bridges). These clients must detect disconnection and reconnect themselves. Upon reconnecting, they receive the full, resumed conversation state.

#### Configuration

The lookback period determines how old a conversation's last activity can be before it's considered stale and excluded from the resume process.

-   **Default**: 24 hours
-   **Environment Variable**: `RESUME_LOOKBACK_HOURS`

## 🔐 Security & Data

- Don’t commit `.env` or SQLite databases (`data.db*`).
- Prefer synthetic data; avoid real PHI/PII.
- Use `bun run clean` to reset local state quickly.

## ☸️ Kubernetes

- Deployment manifests live in `k8s/`. See `k8s/README.md` for ingress, secrets, PVCs, and image guidance.
- Reset/Wipe data in Kubernetes: follow `k8s/README.md` → “Reset / Wipe Data” to either delete the PVC(s) for a full reset or run short-lived Jobs that wipe files while keeping the PVC(s).

## ✅ Testing & Guarantees

- Tests validate millisecond timestamp precision and idempotency keys `(conversation, agentId, clientRequestId)`.
- Appending to a closed turn throws; only `message` can close a turn or conversation.

## 🧩 MCP Bridge (optional)

- Bridge endpoint: `/api/bridge/:config64/mcp` where `config64` is base64url‑encoded ConversationMeta.
- Diagnostic: `/api/bridge/:config64/mcp/diag` echoes parsed meta.
- Tools (server‑mode):
  - `begin_chat_thread`: Creates a local conversation from the template and ensures internal agents on the server via the runner registry (survives restarts). Returns `{ conversationId: string }`.
  - `send_message_to_chat_thread`: Send‑only. Inputs `{ conversationId, message, attachments? }`. Returns `{ ok: true, guidance, status: 'waiting' }` — guidance instructs to call `check_replies` (e.g., `waitMs=10000`).
  - `check_replies`: Long‑polling replies since your last external message. Inputs `{ conversationId, waitMs=10000 }`. Returns `{ messages, guidance, status, conversation_ended }`.
- Discovery: conversations created by the bridge are stamped with `metadata.custom.bridgeConfig64Hash = base64url(sha256(config64))` so UIs can match existing and new conversations to a template.
- Wire types: `conversationId` is a string on the wire.

## 📝 TODO / Future Improvements

### WebSocket Client Architecture Refactoring
- **Deduplicate WebSocket subscription logic**: Currently we have two separate implementations:
  - `WsEventStream` (used by agents via WsTransport → WsEvents) - async iteration pattern
  - `WsJsonRpcClient` (used by external.executor.ts) - callback pattern with built-in subscription
- Both handle WebSocket RPC subscriptions and push events but with different APIs
- Consider unifying into a single WebSocket client that can support both patterns
- Related files:
  - `src/agents/clients/event-stream.ts` (WsEventStream)
  - `src/agents/clients/ws.client.ts` (WsJsonRpcClient)  
  - `src/agents/runtime/ws.transport.ts` (WsTransport)
  - `src/agents/runtime/ws.events.ts` (WsEvents)

---

## 🧰 Agent Lifecycle Management (Interfaces)

We expose a unified lifecycle API used by both server and browser implementations.

- IAgentRegistry: persistent record of desired agents
  - `register(conversationId, agentIds)`
  - `unregister(conversationId, agentIds?)`
  - `listRegistered()`

- IAgentHost: live runtime within a process
  - `ensure(conversationId, { agentIds? })` — idempotent; may add agents incrementally
  - `stop(conversationId)` — stop all in this host for the conversation
  - `list(conversationId)` — returns `AgentRuntimeInfo[]`
  - `stopAll()`

- IAgentLifecycleManager: coordinates registry + host
  - `ensure(conversationId, agentIds)` — persist + start; returns ensured runtime info
  - `stop(conversationId, agentIds?)` — remove intent; browser impl supports per‑agent (stop‑and‑re‑ensure remainder)
  - `resumeAll()` — re‑ensure from registry (server or browser)
  - `listRuntime(conversationId)` — live runtime info
  - `clearOthers(keepConversationId)` — browser helper to stop & unregister other conversations in this tab

Browser specifics
- Registry in `localStorage` and runtime in‑tab; supports incremental adds
- Page resumes on load and syncs button state; clears other conversations for this tab

Server specifics
- Registry in SQLite; WS methods: `lifecycle.getEnsured`, `lifecycle.ensure`, `lifecycle.stop`
- Per‑agent stop on server currently stops all for the conversation (subset stop not yet supported)
