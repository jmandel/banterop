# Agent Launch Patterns

This document describes the different patterns for launching and managing agents in the system. Each pattern serves different architectural needs and deployment scenarios.

## Overview

The system supports multiple patterns for agent deployment:
- **External/Distributed**: Agents run as separate clients
- **Server-Managed**: Server creates and manages agents
- **Hybrid/Handoff**: Start external, hand off to server
- **Monolithic**: Everything in-process (for testing)

## Pattern 1: External/Distributed Agents

**Demo**: `src/cli/demo-scenario-remote.ts`

Agents run as separate client processes that connect to the server via WebSocket.

### How it works:
1. Server runs the orchestrator
2. Agents connect as external clients via WebSocket
3. Each agent manages its own lifecycle
4. Server only orchestrates message passing

### Usage:
```bash
# Start server
bun run dev

# In another terminal, start remote agents
bun run src/cli/demo-scenario-remote.ts
```

### Key characteristics:
- Agents run **outside** the server process
- Can run on different machines
- Agents marked as `kind: 'external'` in metadata
- Server doesn't manage agent lifecycle
- Good for distributed deployments

### Code example:
```typescript
// Create conversation with external agents
const convResult = await rpcClient.call('createConversation', {
  meta: {
    title: 'Remote Agents Demo',
    agents: [
      { id: 'agent-1', kind: 'external' },
      { id: 'agent-2', kind: 'external' }
    ]
  }
});

// Start agents locally with WebSocket transport
const agent1 = new ScriptAgent(new WsTransport(wsUrl), script1);
await agent1.start(conversationId, 'agent-1');
```

## Pattern 2: Server-Managed Agents

**Demo**: `src/cli/demo-server-managed.ts`

Server creates and manages agents internally using its factory system.

### How it works:
1. Client requests conversation with internal agents
2. Server creates agents using factory
3. Agents run inside server process
4. Server maintains agents across restarts

### Usage:
```bash
# Start server
bun run dev

# In another terminal, request server-managed agents
bun run src/cli/demo-server-managed.ts
```

### Key characteristics:
- Agents run **inside** the server process
- Server fully manages lifecycle
- Agents marked as `kind: 'internal'` in metadata
- Persists across server restarts with `autoRun: true`
- Good for centralized deployments

### Code example:
```typescript
// Create conversation with server-managed script agents
const convResult = await rpcClient.call('createConversation', {
  meta: {
    title: 'Server-Managed Demo',
    tags: ['server-managed', 'script-agents'],
    startingAgentId: 'agent-1',
    agents: [
      { 
        id: 'agent-1',
        kind: 'internal',
        agentClass: 'script',
        config: {
          script: {  // Pass script as JSON
            name: 'demo-script',
            turns: [
              [{ kind: 'post', text: 'Hello!', finality: 'turn' }]
            ]
          }
        }
      }
    ],
    custom: {
      autoRun: true  // Auto-start on server restart
    }
  }
});
```

## Pattern 3: Granular Handoff

**Demo**: `src/cli/demo-granular-handoff.ts`

Start with external agents, then selectively hand off to server.

### How it works:
1. Start conversation with external agents
2. Agents run locally initially
3. Selectively hand off specific agents to server
4. Server takes over management of handed-off agents

### Usage:
```bash
# Start server
bun run dev

# In another terminal, demo handoff
bun run src/cli/demo-granular-handoff.ts
```

### Key characteristics:
- Flexible migration from external to internal
- Granular control per agent
- Good for gradual migration scenarios
- Useful when clients disconnect

### Code example:
```typescript
// Start with external agents
const convResult = await rpcClient.call('createConversation', {
  meta: {
    agents: [
      { id: 'agent-1', kind: 'external' },
      { id: 'agent-2', kind: 'external' }
    ]
  }
});

// Start agent-1 locally
const agent1 = new ScriptAgent(transport, script);
await agent1.start(conversationId, 'agent-1');

// Later, hand off agent-2 to server
await rpcClient.call('startAgents', {
  conversationId,
  agentIds: ['agent-2']  // Server takes over these agents
});
```

## Pattern 4: Monolithic/In-Process

**Demo**: `src/cli/demo-scenario-agents.ts`

Everything runs in a single process for testing and development.

### How it works:
1. Create local App instance with in-memory database
2. Create agents with InProcessTransport
3. Direct method calls, no networking
4. Everything in one process

### Usage:
```bash
# Run standalone demo
bun run src/cli/demo-scenario-agents.ts
```

### Key characteristics:
- Self-contained, no external dependencies
- Great for testing and development
- Direct debugging capability
- Not for production use

### Code example:
```typescript
// Create app with in-memory database
const app = new App({ 
  dbPath: ':memory:',
  defaultLlmProvider: 'mock'
});

// Create agents with in-process transport
const transport = new InProcessTransport(app.orchestrator);
const agent = new ScriptAgent(transport, script);
await agent.start(conversationId, 'agent-1');
```

## API Reference

### Creating Conversations

```typescript
// RPC method: 'createConversation'
{
  meta: {
    title: string,
    tags?: string[],
    scenarioId?: string,
    startingAgentId?: string,  // Which agent starts
    agents: [{
      id: string,
      kind: 'internal' | 'external',
      agentClass?: 'script' | 'scenario' | 'assistant',
      config?: {
        script?: TurnBasedScript,  // For script agents
        provider?: string,         // LLM provider
        model?: string             // LLM model
      }
    }],
    custom?: {
      autoRun?: boolean  // Auto-start on server restart
    }
  }
}
```

### Starting Specific Agents (Granular Control)

```typescript
// RPC method: 'startAgents'
{
  conversationId: number,
  agentIds: string[]  // Specific agents to start/handoff
}
```

### Auto-Run Behavior

```typescript
// RPC method: 'autoRun'
{
  conversationId: number
}
// Marks conversation for auto-start on server restart
// Starts all internal agents immediately
```

## Agent Classes

The `agentClass` field determines which implementation to use:

- **`'script'`**: Follows predefined script (requires `config.script`)
- **`'scenario'`**: Uses scenario configuration with LLM
- **`'assistant'`**: General assistant with LLM
- **`'echo'`**: Simple echo agent (for testing)

## Script Agent Configuration

Scripts are passed as JSON in the agent config:

```typescript
{
  id: 'my-agent',
  kind: 'internal',
  agentClass: 'script',
  config: {
    script: {
      name: 'my-script',
      defaultDelay: 100,
      maxTurns: 10,
      turns: [
        [{ 
          kind: 'post', 
          text: 'Hello!', 
          finality: 'turn'  // or 'conversation' to end
        }],
        [{ 
          kind: 'post', 
          text: 'How can I help?', 
          finality: 'turn' 
        }]
      ]
    }
  }
}
```

## Server Restart Behavior

Conversations with `autoRun: true` will automatically restart their internal agents when the server restarts. This ensures continuity for server-managed agents.

## Choosing a Pattern

### Use External/Distributed when:
- Agents need to run on different machines
- You want independent agent scaling
- Agents have different resource requirements
- You need fault isolation between agents

### Use Server-Managed when:
- You want centralized management
- Agents should persist across restarts
- You need simple deployment
- All agents can run on one machine

### Use Granular Handoff when:
- You need flexible migration strategies
- Clients may disconnect/reconnect
- You want gradual migration to server
- Mixed deployment scenarios

### Use Monolithic when:
- Testing and development
- Quick prototyping
- Debugging agent interactions
- Running demos

## Running the Demos

All demos are in `src/cli/`:

```bash
# External/distributed agents
bun run src/cli/demo-scenario-remote.ts

# Server-managed agents
bun run src/cli/demo-server-managed.ts

# Granular handoff
bun run src/cli/demo-granular-handoff.ts

# Monolithic (testing)
bun run src/cli/demo-scenario-agents.ts
```

Each demo includes the knee MRI prior authorization scenario to demonstrate agent interactions in different deployment patterns.