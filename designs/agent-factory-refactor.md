# Agent Factory Refactor — Transport-Agnostic Instantiation

## Context

Today, we create and run "internal" agents (EchoAgent, AssistantAgent, ScenarioDrivenAgent) using in-process transports. External agents connect via WS/MCP and are not instantiated by the server. Some code paths directly `new` specific agent classes, and the term "internal" leaked into the factory API, conflating agent type with execution strategy (where the loop runs).

## Goals

- Decouple agent instantiation from transport choice.
- Centralize agentClass → implementation mapping in one place.
- Provide a single unified API that works identically for server-side and client-side execution.
- Simplify agent context by having transports own their event streams.
- Preserve existing behavior and tests; avoid breaking API consumers.

## Non‑Goals

- Introducing a new network transport or protocol.
- Changing agent behaviors/policies.
- Rewriting CLI flows.

## Approach

1) **Unify transport and events** - Transports own their event streams:
   - `IAgentTransport` interface gains `createEventStream()` method
   - Removes redundant `IAgentEvents` parameter from agent constructors
   - Agent context only needs transport, not both transport + events

2) **Single unified factory** for all execution modes:
   - `startAgents({ conversationId, transport, providerManager, agentIds? })` → `{ agents, stop() }`
   - Works identically for server-side (InProcessTransport) and client-side (WsTransport)
   - Transport determines execution location, not the API

3) **Remove redundant APIs**:
   - Delete `startScenarioAgents` entirely (scenario is an implementation detail)
   - Deprecate `startInternalAgents` in favor of `startAgents`
   - Keep `createAgent` as low-level factory for single agent instantiation

4) **Simplify agent construction**:
   - Agents receive only transport in constructor (transport provides events)
   - Agent context (TurnContext) uses transport.postMessage, transport.postTrace, etc.
   - No more passing both transport and events separately

## New/Updated APIs

### Primary API (NEW)
```typescript
interface StartAgentsOptions {
  conversationId: number;
  transport: IAgentTransport;  // InProcessTransport or WsTransport
  providerManager: ProviderManager;
  agentIds?: string[];  // Optional filter for which agents to start
}

startAgents(options: StartAgentsOptions): Promise<{
  agents: BaseAgent[];
  stop(): Promise<void>;
}>
```

### Transport Interface (UPDATED)
```typescript
interface IAgentTransport {
  // Existing methods
  postMessage(params: MessageParams): Promise<AppendResult>;
  postTrace(params: TraceParams): Promise<AppendResult>;
  getConversation(conversationId: number): Promise<ConversationSnapshot>;
  claimTurn(conversationId: number, agentId: string, guidanceSeq: number): Promise<boolean>;
  
  // NEW: Transport owns event stream creation
  createEventStream(conversationId: number, includeGuidance: boolean): IAgentEvents;
}
```

### Low-level Factory (UPDATED)
```typescript
createAgent(
  agentMeta: AgentMeta,
  transport: IAgentTransport,  // No more separate events parameter
  providerManager: ProviderManager,
  scenario?: ScenarioConfiguration
): BaseAgent
```

### Deprecated APIs
- ~~`startInternalAgents`~~ → Use `startAgents` with `InProcessTransport`
- ~~`startScenarioAgents`~~ → Removed entirely
- ~~`createAgentForMeta`~~ → Use `createAgent` directly

## agentClass Mapping

- `assistantagent` → `AssistantAgent`
- `echoagent` → `EchoAgent`
- default → `ScenarioDrivenAgent` (requires scenario role match). Falls back to `AssistantAgent` when scenario is missing or role not present.

## Provider Selection

- Per‑agent override via `AgentMeta.config` supports `llmProvider|provider`, `model`, `apiKey`.
- Falls back to `ProviderManager` default when unspecified.

## Usage Scenarios

### Scenario 1: WS → Start agents on backend
```typescript
// In WebSocket handler (runConversationToCompletion)
await startAgents({
  conversationId,
  transport: new InProcessTransport(orchestrator),
  providerManager
});
```

### Scenario 2: WS → Run agents locally (client-side)
```typescript
// In client code
await startAgents({
  conversationId,
  transport: new WsTransport(wsUrl),
  providerManager: clientProviderManager
});
```

### Scenario 3: Backend → Start agents internally
```typescript
// In MCP bridge, auto-resume, etc.
await startAgents({
  conversationId,
  transport: new InProcessTransport(orchestrator),
  providerManager
});
```

## Call‑Site Changes

- `src/server/ws/jsonrpc.server.ts`
  - Replace `startScenarioAgents` with `startAgents`
  
- `src/server/bridge/mcp-server.ts`
  - Replace `startInternalAgents` with `startAgents`

- `src/server/app.ts` (auto-resume)
  - Replace `startScenarioAgents` with `startAgents`

- `src/agents/factories/scenario-agent.factory.ts`
  - Delete entire file (functionality absorbed into unified factory)

- `src/agents/runtime/base-agent.ts`
  - Update constructor to only take transport (not events)
  - Get events via `transport.createEventStream()`

## Implementation Details

### BaseAgent Constructor Changes
```typescript
// OLD - receives both transport and events
class BaseAgent {
  constructor(
    protected transport: IAgentTransport,
    protected events: IAgentEvents
  ) {}
}

// NEW - transport provides events
class BaseAgent {
  protected events: IAgentEvents;
  
  constructor(protected transport: IAgentTransport) {
    // Transport creates its own event stream
    this.events = transport.createEventStream(conversationId, true);
  }
}
```

### Agent Context Simplification
```typescript
// OLD - TurnContext has both
interface TurnContext {
  transport: IAgentTransport;
  events: IAgentEvents;
  // ...
}

// NEW - TurnContext only needs transport
interface TurnContext {
  transport: IAgentTransport;  // Can get events from transport if needed
  // ...
}
```

## Backwards Compatibility

For a smooth transition:

1. **Phase 1**: Add new unified API alongside existing ones
   - Implement `startAgents` and transport.createEventStream()
   - Keep `startInternalAgents` as deprecated wrapper calling `startAgents`
   - Mark `startScenarioAgents` as deprecated

2. **Phase 2**: Migrate call sites
   - Update WebSocket server, MCP bridge, app.ts to use `startAgents`
   - Update BaseAgent to use transport-provided events
   - Update all agent implementations

3. **Phase 3**: Remove deprecated code
   - Delete `startScenarioAgents` and scenario-agent.factory.ts
   - Remove `startInternalAgents` 
   - Remove separate events parameter from agent constructors

## Migration Plan

1. **Update transport interfaces** to add `createEventStream()`
2. **Implement unified `startAgents`** function
3. **Update BaseAgent** to get events from transport
4. **Migrate all call sites** to use new API
5. **Delete redundant code** (scenario factory, deprecated functions)
6. **Update tests** to use unified factory

## Alternatives Considered

- Multiple per‑agent factories: too much duplication, increases drift risk.
- Hard‑wiring transport choices in factories: prevents reuse for WS/MCP.

## Benefits of This Design

1. **True transport agnosticism** - Same code works for any execution location
2. **Simpler agent implementation** - Agents only deal with one transport object
3. **Cleaner separation of concerns** - Transport owns its event delivery mechanism
4. **Unified API** - One way to start agents, regardless of where they run
5. **Better testability** - Can mock a single transport instead of transport + events

## Risks & Mitigations

- **Breaking change for existing agents** → Phased migration with compatibility wrappers
- **Transport implementations need updating** → Add default implementation that creates separate event stream
- **Test updates required** → Update test utilities to match new patterns

## Next Steps

1. Review and approve this updated design
2. Implement transport.createEventStream() for existing transports
3. Create unified startAgents() function
4. Migrate existing code in phases
5. Remove deprecated code once migration complete

