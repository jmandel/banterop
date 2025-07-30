# Language-First Interoperability Reference Stack

This repository contains a self-contained reference implementation for designing, executing, and integrating multi-agent, language-first workflows. It is designed to be readable, straightforward, and serves as the official reference stack for the **"Language First Interoperability"** track at the HL7 FHIR Connectathon.

The project demonstrates how complex healthcare processes—like prior authorizations, specialist appointment booking, or clinical trial matching—can be modeled as conversations between AI agents. These agents **communicate with each other through a sequence of conversational turns**, sharing data and negotiating outcomes dynamically to solve problems on behalf of their principals.

- **Explore Scenarios & Watch Conversations Live**: `https://hi.argo.run`
- **API & WebSocket Endpoint**: `https://hi.argo.run/api`

---

## Table of Contents

- [The Goal of Language-First Interoperability](#the-goal-of-language-first-interoperability)
- [The Role of Scenarios in the Connectathon](#the-role-of-scenarios-in-the-connectathon)
- [The Goal of This Reference Stack](#the-goal-of-this-reference-stack)
- [Connectathon Usage Guide](#connectathon-usage-guide)
  - [Mode 1: Internal Simulation](#mode-1-internal-simulation)
  - [Mode 2: Connecting External Agents (MCP & A2A Bridges)](#mode-2-connecting-external-agents-mcp--a2a-bridges)
- [Key Features](#key-features)
- [Architecture at a Glance](#architecture-at-a-glance)
- [Core Concepts](#core-concepts)
- [API Highlights](#api-highlights)
- [Project Structure](#project-structure)
- [For Developers: Running Locally](#for-developers-running-locally)

---

### The Goal of Language-First Interoperability

The goal of Language-First Interoperability (LFI) is to enable autonomous AI agents, deployed by real-world organizations, to "just talk" to solve complex healthcare problems. Each agent has access to its own data, rules, and capabilities. Instead of relying on rigid, pre-defined APIs, they engage in fluid, context-aware conversations to achieve goals on behalf of their principals.

### The Role of Scenarios in the Connectathon

In the real world, agents are driven by high-level goals. For a focused testing event like a connectathon, we need a controlled environment. **Scenarios are a testing artifact** created specifically for this purpose. They provide:

1.  **A Shared Problem Space:** A consistent set of facts, roles, and objectives ensures all participants are solving the same problem.
2.  **A Controlled Environment:** They define the "rules of the game," including available tools and ground-truth data (e.g., a patient's medical history).
3.  **Measurable Success:** By defining clear success and failure conditions (via tool naming conventions), scenarios allow us to objectively assess whether an exchange was successful.

### The Goal of This Reference Stack

This repository provides the reference implementation for the Connectathon track. Its primary goal is to support the testing of diverse scenarios with **maximum transparency and flexibility.**

-   **Transparency:** The **Conversation Inspector** provides a "glass box" view into agent behavior. It features a three-pane layout: the shared conversation appears in the center, while agent-specific traces are shown on the left and right. This allows you to see exactly how each agent arrived at its conversational turns.
-   **Flexibility:** The stack is built on a **transport-agnostic client architecture**. You can seamlessly test agents connecting remotely via WebSocket, allowing you to validate your external agent against a reliable, transparent counterpart.
-   **Control:** The **Scenario Builder UI** allows you to see the exact rules, context, and tools that govern any test run.

## Connectathon Usage Guide

This reference stack is your primary tool for testing. It supports two main modes, defined by the `managementMode` property when a conversation is created.

### Mode 1: Internal Simulation

First, you can run a scenario where all agents are provisioned and managed by the platform. This is perfect for understanding the expected flow of a conversation.

1.  Navigate to `https://hi.argo.run`. Use the **Dashboard** to create a new conversation.
2.  Select a pre-built scenario. The orchestrator will automatically start the reference agents.
3.  Open the **Conversation Inspector**. A new tab for your conversation will appear automatically.
4.  Watch the conversation unfold in real-time. Click any turn to see the detailed trace of how the agent reasoned its way to that response.

### Mode 2: Connecting External Agents (MCP & A2A Bridges)

The real power of the stack is its ability to let you **"swap in" your own agent**. This allows you to test your implementation against our transparent reference agents.

The reference implementation uses a native, fully asynchronous "chat room" protocol internally. To support external participants, we will provide **bridges** that map this protocol to standard interoperability protocols like MCP and A2A.

#### MCP Bridge (Client-Initiated)

For the connectathon, we plan to offer an MCP bridge that simplifies asynchronous interaction into a series of tool calls. This provides an easy entry point for participants with existing MCP clients. An external MCP client would interact with a reference agent by calling the following tools:

-   `begin_chat_thread()`: Initiates a conversation with a reference agent. The tool's description will advertise the agent's role and capabilities. Returns a `thread_id`.
-   `send_message_to_chat_thread({ thread_id, message })`: Sends a message to the reference agent and waits for a reply. This simplifies the interaction to an alternating-turns conversation.
-   `wait_for_reply({ thread_id })`: A recovery tool to fetch a reply if the `send_message` call times out, a common issue with slow-responding LLM-backed agents.

#### A2A Bridge (Fully Asynchronous)

We also plan to offer an A2A bridge for a more robust, truly asynchronous experience.
-   An external A2A client can initiate a conversation with a reference A2A server.
-   Either party can send a message to the conversation at any time.
-   The protocol allows clients to learn immediately when a new message is available, enabling more fluid and complex workflows.

Both bridges will accommodate **human-in-the-loop** interactions. While MCP clients often have a natural user interface for this, the reference stack will provide mechanisms for A2A clients and servers to surface questions to a human and incorporate their responses.

## Key Features

- **Scenario Builder:** A web UI for creating and editing `ScenarioConfiguration` files, where test cases are designed.
- **Live Conversation Inspector:** A real-time UI that provides a three-pane view of any conversation: the central dialogue, and side panels showing the detailed, step-by-step reasoning (`TraceEntry` data) for each agent's message.
- **Transport-Agnostic Clients:** A unified `OrchestratorClient` interface abstracts away the communication layer. Agents can run in the same process as the server (`InProcessOrchestratorClient`) or connect remotely (`WebSocketJsonRpcClient`).
- **Internal & External Agent Management:** Conversations can be configured for fully managed simulations (`internal`) or to allow external agents to connect on-demand (`external`).

## Architecture at a Glance

1.  **Frontend UIs (`/src/frontend`):** A suite of React applications for interacting with the system, including the Dashboard, Scenario Builder, and Conversation Inspector.
2.  **Backend Server (`/src/backend`):** A Hono server running on Bun, which includes:
    -   **Conversation Orchestrator:** The **shared environment and authoritative record for conversations**. It manages conversation state, **broadcasts turns and events to subscribed agents**, and provisions internal agents for simulations.
    -   **WebSocket Server:** A JSON-RPC endpoint for real-time agent and UI communication.
    -   **REST API:** Endpoints for managing conversations, scenarios, and user queries.
3.  **Orchestrator Client (`/src/client`):** A library that agents use to interact with the conversational environment, decoupling agent logic from the communication protocol.
4.  **Database (`/src/backend/db`):** An in-memory or file-based SQLite database for persistence.

## Core Concepts

- **`ScenarioConfiguration`**: A JSON object that provides the complete context for a simulation, including agent roles, goals, tools, and ground-truth data.
- **`ConversationTurn`**: An entry in the public conversation log. It is *what* happened.
- **`TraceEntry`**: A detailed, private step an agent took to produce a `Turn` (e.g., a thought or tool call). It is *how* the agent decided what to do.
- **`OrchestratorClient`**: A critical abstraction that provides an agent's connection **to the shared conversational environment**, decoupling its logic from the transport layer (in-process vs. WebSocket).
- **`managementMode`**: A conversation property (`internal` or `external`) that determines whether the orchestrator or an external process is responsible for the agent lifecycle.

## API Highlights

The backend exposes both a REST API and a WebSocket JSON-RPC API at `https://hi.argo.run/api`.

#### WebSocket JSON-RPC API (`/api/ws`)

This is the primary interface for external agents. Key methods include:
- `authenticate({ token })`: Authenticates the agent.
- `subscribe({ conversationId })`: Subscribes to conversation events.
- `startTurn()`, `addTrace()`, `completeTurn()`: The streaming API for contributing a turn to the conversation.
- `createUserQuery({ question })`: Pauses to ask a human principal a question.

#### REST API (`/api`)

- `POST /conversations`: Creates a new conversation.
- `POST /conversations/:id/start`: Starts an `internal` conversation.
- `GET /conversations/:id`: Retrieves the full state of a conversation.
- `GET /queries/pending`: Retrieves all pending user queries.
- `POST /queries/:id/respond`: Allows a human to respond to a query.

## Project Structure

```
.
├── src/
│   ├── agents/             # Core agent logic, strategies, and factory
│   ├── backend/            # Hono server, orchestrator, database, and API routes
│   ├── client/             # Transport-agnostic client implementations
│   ├── frontend/           # React sources for all web UIs
│   │   ├── dashboard/
│   │   ├── external-executor/
│   │   ├── scenario-builder/
│   │   └── trace-viewer/
│   ├── lib/                # Shared utilities
│   └── types/              # Domain-specific TypeScript types
├── tests/
│   ├── e2e/
│   ├── integration/
│   └── unit/
└── README.md
```

## For Developers: Running Locally

While the Connectathon will use a hosted version, you can run the entire environment locally.

### Quick Start

1.  **Clone the repository and install dependencies:**
    ```bash
    git clone <repository_url>
    cd <repository_directory>
    bun install
    ```

2.  **Configure your LLM provider:**
    The system uses the Google Gemini API by default. Create a `.env` file in the project root:
    ```
    # .env
    GEMINI_API_KEY="your-google-ai-api-key"
    ```

3.  **Run the development server:**
    This will start the backend and all frontend development servers concurrently.
    ```bash
    bun run dev
    ```

4.  **Access the UIs in your browser:**
    -   **Backend API:** `http://localhost:3001`
    -   **Dashboard:** `http://localhost:5173` (or as indicated in console)
    -   **Scenario Builder:** `http://localhost:5174`
    -   **Conversation Inspector:** `http://localhost:5175`
    -   **External Executor Demo:** `http://localhost:5176`

To run the test suite, use `bun test`.
