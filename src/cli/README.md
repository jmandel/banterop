# CLI Demo Scripts

This directory contains demonstration scripts showing various ways to interact with the language-track v3 system.

## Available Demos

### 1. Server-Side Agent Execution (`demo-server-agents.ts`)
- Connects to existing server on port 3000
- Creates conversation with agents marked as `kind: 'internal'`
- Uses `runConversationToCompletion` to trigger backend execution
- Agents run entirely on the server using InProcessTransport

```bash
bun run src/cli/demo-server-agents.ts
```

### 2. Client-Side Agent Execution (`demo-client-agents.ts`)
- Connects to existing server
- Creates conversation with agents marked as `kind: 'external'`
- Uses WsTransport to run agents locally on the client
- Demonstrates client-managed agent lifecycle

```bash
bun run src/cli/demo-client-agents.ts
```

### 3. Backend-Only Execution (`demo-backend-agents.ts`)
- Runs without any server (uses in-memory database)
- Direct orchestrator usage with InProcessTransport
- Good for testing agent logic without network overhead

```bash
bun run src/cli/demo-backend-agents.ts
```

### 4. Mixed Mode (`demo-mixed-mode.ts`)
- Some agents run on server (internal), others on client (external)
- Shows seamless interaction between different execution locations
- Demonstrates true transport-agnostic design

```bash
bun run src/cli/demo-mixed-mode.ts
```

### 5. Interactive Scenario Builder (`demo-scenario-builder.ts`)
- Interactive prompts to build custom scenarios
- Create agents with custom roles and goals
- Test scenarios in real-time conversation

```bash
bun run src/cli/demo-scenario-builder.ts
```

### 6. Resume Conversation (`demo-resume-conversation.ts`)
- Resume existing conversations by ID
- Shows conversation history and current state
- Continue interaction from where it left off

```bash
bun run src/cli/demo-resume-conversation.ts
```

## Key Features Demonstrated

### Preconditions and CAS (Compare-And-Swap)
All demos properly track `lastClosedSeq` and include preconditions when posting messages to prevent race conditions during turn-taking.

### Transport Abstraction
The unified `startAgents()` API works with any transport:
- `InProcessTransport` - Direct orchestrator calls (server-side)
- `WsTransport` - WebSocket JSON-RPC (client-side)

### Agent Types
- `EchoAgent` - Simple echo responses
- `AssistantAgent` - LLM-powered responses
- `ScenarioDrivenAgent` - Scenario-aware behavior

## Important Notes

1. **Server Requirement**: Most demos (except `demo-backend-agents.ts`) require the server to be running:
   ```bash
   bun run dev  # In another terminal
   ```

2. **Sequence Number Isolation**: The system currently uses global sequence numbers which can leak information across conversations. See `seq-isolation-issue.md` for details and proposed solutions.

3. **Preconditions**: All agents must include `precondition: { lastClosedSeq }` when starting new turns to ensure proper coordination.

## Architecture Overview

```
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│   Client    │       │   Server    │       │   Backend   │
│   Agents    │◄─────►│  WebSocket  │◄─────►│ Orchestrator│
│(WsTransport)│  WS   │   Server    │       │  + Agents   │
└─────────────┘       └─────────────┘       └─────────────┘
                           JSON-RPC          InProcessTransport
```

The transport abstraction allows agents to run in any location while maintaining the same programming model and coordination guarantees.