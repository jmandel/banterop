# 🔥 BURN PLAN: Dead Code Removal

## Context
We just completed a major migration from a complex polling-based agent coordination system to a simpler "Guidance + Claim" turn-coordination model. The migration is complete and working, but there's significant dead code left behind that needs to be removed.

## Key Architecture Changes Made
- **Before**: Complex `getUpdatesOrGuidance()` and `waitForChange()` polling with timeouts
- **After**: Simple async iteration over event streams with `claim_turn` coordination
- **Result**: 2000+ lines removed, replaced with <500 lines of cleaner code

## Dead Code to Remove

### 1. Legacy IAgentClient Methods ❌
**Files**: 
- `src/agents/agent.types.ts`
- `src/agents/executors/turn-loop.executor.ts` (lines 201-208)
- `src/agents/executors/internal-turn-loop.ts` (lines 183-189)

**What to remove**:
- `getUpdatesOrGuidance()` method from IAgentClient interface
- `waitForChange()` method from IAgentClient interface
- Their stub implementations that just throw errors

**Why**: These were the core of the old polling system. With guidance events and turn claims, agents no longer poll - they react to events.

### 2. Legacy Orchestration Flags ❌
**Files**:
- `src/server/config.ts`
- `src/server/orchestrator/orchestrator.ts` (lines 230-238)
- `src/types/orchestrator.types.ts`
- All simulation files that set `emitNextCandidates`

**What to remove**:
- `emitNextCandidates` config flag entirely
- Code that emits `next_candidate_agents` system events
- Any references to this flag in tests/simulations

**Why**: This was the old way of signaling who should speak next. Now we use guidance events exclusively.

### 3. Entire MCP Bridge Directory ❌
**Files**:
- `src/server/bridge/mcp.contract.ts`
- `src/server/bridge/mcp.server.ts`
- `src/server/bridge/mcp.server.test.ts`

**What to do**: Delete the entire `src/server/bridge/` directory

**Why**: This bridge was built for the old polling-based system. It uses `wait_for_updates` semantics that don't align with our new event-stream architecture. If we need MCP support later, we should rebuild it using guidance events.

### 4. Unused scenario.types.ts ❌
**Files**:
- `src/types/scenario.types.ts`

**What to do**: Delete entirely

**Why**: The design doc (006-convo-metadata.md) explicitly states this should be removed and we should reuse `ConversationMeta.AgentMeta` instead. We already have rich metadata support in `conversation.meta.ts`.

### 5. Duplicate InProcessClient ❌
**Files**:
- `src/agents/clients/inprocess.client.ts` (KEEP THIS ONE)
- `src/agents/executors/internal-turn-loop.ts` (lines 127-192 - REMOVE)

**What to do**: 
- Remove the inline `InProcessClient` class from internal-turn-loop.ts
- Import and use the one from `src/agents/clients/inprocess.client.ts`

**Why**: Code duplication. We have a proper client implementation that should be reused.

### 6. Unused Agent Turn Outcomes ❌
**Files**:
- `src/agents/agent.types.ts`
- `src/agents/script/script.agent.ts`

**What to remove**:
- `'yield'` and `'no_action'` from TurnOutcome type
- The 'wait' action in script.agent.ts (lines 16-20)
- The 'yield' case in script.agent.ts

**Why**: These outcomes don't make sense in the new architecture where agents only run when they have the turn. An agent either posts messages or completes.

### 7. Legacy System Event Types ❌
**Files**:
- `src/types/event.types.ts`

**What to remove from SystemPayload kind**:
- `'next_candidate_agents'` 
- `'policy_hint'`

**Why**: These were part of the old advisory system. Guidance events have replaced them.

## Implementation Order

1. **Start with types** - Remove from interfaces first to see what breaks
2. **Fix implementations** - Remove stub methods and dead code
3. **Delete entire files/directories** - MCP bridge, scenario.types.ts
4. **Update tests** - Remove any tests for deleted functionality
5. **Update simulations** - Remove legacy flags and configs
6. **Final cleanup** - Search for any remaining references

## Validation

After burning it all down, ensure:
1. `bun typecheck` passes
2. `bun test` passes
3. All simulations still run:
   - `bun run ./src/cli/run-sim-inproc.ts`
   - `bun run ./src/cli/run-sim-ws-simple.ts`
   - `bun run ./src/cli/run-sim-ws-new.ts`
   - `bun run ./src/cli/run-sim-metadata.ts`

## What NOT to Remove

Keep these as they're still useful:
- `emitGuidance` flag - This is the new system
- `claim_turn` infrastructure
- Event stream classes
- Current `postMessage` and `postTrace` methods
- The 'posted' and 'complete' turn outcomes

## Expected Impact

- Remove ~500-800 more lines of dead code
- Eliminate confusion about which patterns to use
- Make the codebase cleaner for new developers
- No functionality should be lost - everything should work exactly the same

## Search Commands to Find Stragglers

After the burn, search for these terms to ensure complete removal:
```bash
# These should return no results:
grep -r "getUpdatesOrGuidance" src/
grep -r "waitForChange" src/
grep -r "emitNextCandidates" src/
grep -r "next_candidate_agents" src/
grep -r "mcp.contract" src/
grep -r "mcp.server" src/
grep -r "scenario.types" src/
```

## Note for Implementer

Be aggressive! This is greenfield code with no legacy users. If something looks dead or confusing, it probably is. The new pattern is simple:
1. Orchestrator emits guidance events
2. Agents listen for guidance
3. Agents claim turns atomically
4. Agents post messages
5. Repeat

Anything that doesn't fit this pattern is probably dead code from the old system.