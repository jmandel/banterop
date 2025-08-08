# Migration Complete: Guidance + Claim Turn Coordination

## What Changed

### Before (600+ LOC per executor)
- Complex `getUpdatesOrGuidance()` polling logic
- `waitForChange()` with timeouts and retries  
- `decideIfMyTurn()` logic duplicated in every executor
- Different code paths for internal vs external agents
- `spawnInternalWorker` with in-flight tracking

### After (< 100 LOC per executor)
```typescript
for await (const event of eventStream) {
  if (isGuidanceForMe(event)) {
    if (await claimTurn()) {
      await agent.handleTurn(ctx);
    }
  }
}
```

## Files Deleted (2000+ LOC removed)
- `src/agents/external/external.executor.ts` - 600+ LOC
- `src/agents/external/simple.executor.ts` - 100+ LOC
- `src/agents/clients/ws.client.ts` - 350+ LOC
- `src/server/orchestrator/worker-runner.ts` - 50+ LOC
- `src/server/orchestrator/internal.executor.ts` - 50+ LOC
- Legacy test files and simulations

## New Components (< 500 LOC total)
- `src/agents/executors/turn-loop.executor.ts` - 120 LOC
- `src/agents/executors/internal-turn-loop.ts` - 100 LOC  
- `src/agents/clients/event-stream.ts` - 300 LOC
- `src/db/turn-claim.store.ts` - 100 LOC

## Key Benefits

1. **Unified Architecture**: Internal and external agents use identical patterns
2. **No Polling**: Event streams handle all waiting/reconnection
3. **No Race Conditions**: SQLite turn claims provide atomic coordination
4. **Simpler Agents**: Agents just implement `handleTurn()`, no orchestration logic
5. **Better Testability**: Clean separation of concerns

## Configuration

Enable the new system:
```typescript
new App({
  emitGuidance: true,      // Enable guidance events
  emitNextCandidates: false // Disable legacy system
})
```

## Migration Path for External Agents

Replace:
```typescript
const executor = new ExternalExecutor(agent, {
  conversationId,
  agentId,
  url,
  decideIfMyTurn: complexLogic,
  pollTimeoutMs: 500
});
```

With:
```typescript
const executor = new TurnLoopExecutor(agent, {
  conversationId,
  agentId,
  wsUrl
});
```

That's it! No more polling, no more complex turn logic.