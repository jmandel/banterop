# Technical Proposal: Ensure Agents Running

## Goals

1. **Explicit Control**: Provide explicit control over when and where agents start running, avoiding automatic/implicit behavior
2. **Unified Interface**: Single API that works for both internal (server-managed) and external (client-managed) agents
3. **Persistent Execution**: Once started, agents should keep running until explicitly stopped
4. **Location Flexibility**: Support running agents either internally (in-process on server) or externally (client-side)
5. **Granular Management**: Control specific agents by ID rather than all-or-nothing

## Current State

### What We Have
- `startAgents()` factory function that creates and starts agents based on metadata
- RPC method `'startAgents'` that wraps this for server-side execution
- Transport abstraction (InProcessTransport vs WsTransport)
- Agent metadata in conversations specifying `kind: 'internal' | 'external'`

### Problems
- No unified way to ensure agents are running from both server and client contexts
- `autoRun` behavior is implicit and happens at conversation creation
- No clear semantics around "keep running" vs "start once"
- Mixing of concerns between agent location and agent lifecycle

## Proposed Design

### Core Function: `ensureAgentsRunning`

```typescript
interface EnsureAgentsRunningOptions {
  conversationId: number;
  agentIds: string[];           // Explicit list of agents
  transport: IAgentTransport;   // Determines execution context
  providerManager: LLMProviderManager;
}

async function ensureAgentsRunning(options): Promise<AgentHandle>
```

### Key Invariants

1. **Idempotent**: Calling multiple times with same agents is safe - won't create duplicates
2. **Explicit**: No automatic starts - must be explicitly called
3. **Persistent**: Started agents continue running until explicitly stopped
4. **Transport-agnostic**: Same function works with any transport implementation

### Implementation Approach

#### Phase 1: Core Implementation
1. Create `ensureAgentsRunning` as a standalone function
2. It wraps existing `startAgents` factory
3. Tracks running agents to ensure idempotency
4. Returns handle for lifecycle control

#### Phase 2: RPC Integration
1. Rename RPC method from `'startAgents'` to `'ensureAgentsRunning'`
2. RPC handler determines transport based on request context
3. For internal: uses InProcessTransport
4. For external: returns instructions for client to use WsTransport

#### Phase 3: Client Helpers
1. Browser-compatible wrapper that uses WsTransport
2. Server-side wrapper that uses InProcessTransport
3. Both call same core `ensureAgentsRunning`

### Usage Patterns

#### Server-Side (Internal Agents)
```typescript
// In RPC handler or orchestrator
await ensureAgentsRunning({
  conversationId: 123,
  agentIds: ['agent-1', 'agent-2'],
  transport: new InProcessTransport(orchestrator),
  providerManager
});
```

#### Client-Side (External Agents)
```typescript
// In browser or external client
await ensureAgentsRunning({
  conversationId: 123,
  agentIds: ['agent-3', 'agent-4'],
  transport: new WsTransport(wsUrl),
  providerManager
});
```

#### Mixed Mode (Handoff)
```typescript
// Start external, then hand off to server
// Client stops its agents
await clientHandle.stop();

// Server takes over
await rpcClient.call('ensureAgentsRunning', {
  conversationId: 123,
  agentIds: ['agent-3', 'agent-4']
});
```

## Migration Path

1. **Keep existing `startAgents`** factory as-is (it's the low-level implementation)
2. **Add `ensureAgentsRunning`** as new high-level API
3. **Update RPC method** to use new semantics
4. **Update demos** to use explicit calls instead of autoRun
5. **Deprecate autoRun** in favor of explicit ensureAgentsRunning

## Benefits

1. **Clear Semantics**: "Ensure running" clearly indicates persistent execution
2. **Explicit Control**: No surprises about when agents start
3. **Unified Code Path**: Same logic for internal and external agents
4. **Testable**: Can test agent lifecycle independently of transport
5. **Flexible Deployment**: Easy to move agents between server and client

## Open Questions

1. **Agent Registry**: Should we maintain a global registry of running agents?
2. **Duplicate Prevention**: How to handle if agent is already running elsewhere?
3. **Restart Behavior**: Should server restart automatically re-ensure agents?
4. **Error Recovery**: What happens if an agent crashes?

## Alternative Considered

### Alternative 1: Separate Internal/External Functions
- Pro: Clearer separation of concerns
- Con: Code duplication, harder to maintain

### Alternative 2: Automatic Start on Conversation Creation
- Pro: Convenient for simple cases
- Con: Implicit behavior, hard to control, timing issues

### Alternative 3: Agent Lifecycle Manager Service
- Pro: Centralized management, rich lifecycle features
- Con: More complex, overkill for current needs

## Recommendation

Implement the proposed `ensureAgentsRunning` design because:
1. It provides explicit control as requested
2. It unifies internal and external agent management
3. It builds on existing infrastructure (startAgents factory)
4. It's simple enough to implement quickly but flexible for future needs
5. It makes the "keep running" semantics explicit in the name

## Next Steps

1. Review and refine this proposal
2. Implement core `ensureAgentsRunning` function
3. Update RPC handlers
4. Create client and server helper functions
5. Update demos to use new pattern
6. Document in AGENT-PATTERNS.md