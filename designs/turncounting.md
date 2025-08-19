# Turn Counting Problem Analysis

## Current Issue

The current turn counting logic in `scenario-driven.agent.ts` has a critical flaw:

```typescript
// Current implementation (INCORRECT)
const maxTurn = Math.max(0, ...snapshot.events.map(e => e.turn || 0));
this.currentTurnNumber = maxTurn + 1;
```

This always increments the turn number, but this is wrong when an agent is resuming/continuing its own turn.

## The Problem Scenario

Consider this sequence of events:

1. **Turn 1 starts**: Agent A begins its turn
   - Agent A creates a thought event (turn: 1, agentId: 'agent-a')
   - Agent A makes a tool call (turn: 1, agentId: 'agent-a')
   - Agent A gets interrupted or needs to continue processing
   
2. **Agent A resumes**: The agent's `takeTurn` is called again
   - Current code sees maxTurn = 1
   - Current code sets `this.currentTurnNumber = 2` ❌ WRONG!
   - Agent A should continue using turn 1, not start turn 2

3. **Result**: 
   - Agent A's subsequent events get tagged with turn 2
   - The conversation history shows Agent A having both turn 1 and turn 2
   - The other agent never gets turn 2, leading to confusion

## Real-World Impact

This affects:
1. **LLM Debug Logging**: Turn numbers in metadata are incorrect
2. **Conversation History**: Agents see incorrect turn sequences
3. **Turn-based Logic**: Any logic depending on turn numbers breaks

## How Turn Numbers Should Work

### Core Principles

1. **Turn Ownership**: A turn belongs to the agent that starts it
2. **Turn Continuation**: An agent may be called multiple times within the same turn (e.g., for multi-step processing)
3. **Turn Increment**: A new turn only starts when a DIFFERENT agent takes over

### Correct Logic

```typescript
// Proposed fix
const maxTurn = Math.max(0, ...snapshot.events.map(e => e.turn || 0));

// Check if we already have events in the highest turn
const ourEventsInMaxTurn = maxTurn > 0 ? 
  snapshot.events.filter(e => e.turn === maxTurn && e.agentId === agentId) : [];

if (ourEventsInMaxTurn.length > 0) {
  // We're continuing our current turn
  this.currentTurnNumber = maxTurn;
} else {
  // We're starting a new turn
  this.currentTurnNumber = maxTurn + 1;
}
```

## Examples

### Example 1: Simple Back-and-Forth
```
Events:
1. agent-a sends message (turn: 1)
2. agent-b sends message (turn: 2)  // Different agent, so increment
3. agent-a sends message (turn: 3)  // Different from previous, increment
```

### Example 2: Multi-Step Processing
```
Events:
1. agent-a thought (turn: 1)
2. agent-a tool_call (turn: 1)
3. agent-a tool_result (turn: 1)
4. agent-a message (turn: 1)
5. agent-b thought (turn: 2)  // Different agent, increment
6. agent-b message (turn: 2)
```

### Example 3: Interrupted and Resumed
```
Events:
1. agent-a thought (turn: 1)
2. agent-a tool_call (turn: 1)
// Agent A's takeTurn called again (e.g., after async operation)
3. agent-a tool_result (turn: 1)  // Should still be turn 1!
4. agent-a message (turn: 1)
5. agent-b message (turn: 2)  // Different agent, increment
```

## Testing Considerations

We need to test:
1. Basic turn alternation between agents
2. Multi-step processing within a single turn
3. Agent resumption (same agent called multiple times)
4. Edge case: First turn (no existing events)
5. Edge case: System events between turns

## Related Files

- `/src/agents/scenario/scenario-driven.agent.ts` - Contains the bug
- `/src/types/event.types.ts` - Defines turn field in UnifiedEvent
- `/src/llm/services/debug-logger.ts` - Uses turn numbers for logging paths

## Architectural Solution

The fundamental issue is that agents shouldn't have to infer turn numbers. The orchestrator, as the scheduler and source of truth, should provide this information explicitly.

### Implementation Plan

1. **Update `TurnContext` Interface**: Add a `currentTurnNumber` field to the context that all agents receive
2. **Populate `currentTurnNumber` in `BaseAgent``: Extract the turn number from guidance events
3. **Refactor `ScenarioDrivenAgent`**: Use the explicit turn number from context
4. **Refactor `AssistantAgent`**: Use the explicit turn number for logging metadata
5. **Fix Orchestrator**: Ensure ALL guidance events include turn numbers

### Benefits

- **Single Source of Truth**: Orchestrator controls turn numbering
- **No Inference Required**: Agents receive explicit turn numbers
- **Consistent Behavior**: All agents use the same turn numbering mechanism
- **Simplified Logic**: Removes complex calculation and edge case handling

## Bug Found: Missing Turn Numbers in Guidance Events

During implementation, we discovered that the orchestrator was inconsistently including turn numbers in guidance events. Some code paths included them, but critically, the `handleTurnClosed` method didn't, causing runtime errors.

### Fixed Locations in orchestrator.ts:
1. Line 290: Added `turn: 1` for initial conversation guidance
2. Line 415: Added `turn: 1` for poke guidance 
3. Line 555: Added `turn: e.turn + 1` for next turn after close (THE CRITICAL FIX)

This explains why restarting the agent "fixed" the issue - on restart, different code paths that DID include turn numbers were used.