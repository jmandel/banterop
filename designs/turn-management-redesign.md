# Turn Management Redesign

## Current Problems
1. **Seq jumps**: `lastClosedSeq` points to the last message that closed a turn (finality = turn/conversation), not intermediate messages (finality = none)
2. **Complex preconditions**: Tracking `lastClosedSeq` is confusing and error-prone
3. **Hard restarts**: Agents can't easily restart mid-turn without complex state management
4. **Global sequences**: Seq numbers leak information across conversations (security issue)

## Requirements
1. **Avoid clients clobbering themselves** - Multiple agents shouldn't overwrite each other
2. **Easy agent restart** - Agent should be able to restart and replay entire turn
3. **Clean turn management** - Clear semantics for starting, continuing, and aborting turns
4. **Simple mental model** - Agents should think in terms of turns, not sequence numbers

## Solution: Reset Turn + Simplified Preconditions

### Core Concepts

#### 1. Tentative Turns
A turn is "tentative" until it has a message with `finality: turn` or `finality: conversation`. This is already implicitly true - we're making it explicit.

#### 2. Turn-Based Preconditions (Replaces lastClosedSeq)
Instead of tracking sequence numbers, use simple turn-based preconditions:

```typescript
interface TurnPrecondition {
  expectTurn: number;      // Which turn number we expect
  startingTurn: boolean;   // true = starting new turn, false = continuing existing
}

// Examples:
{ expectTurn: 5, startingTurn: true }   // Start turn 5
{ expectTurn: 5, startingTurn: false }  // Continue turn 5
```

#### 3. Reset Turn (Not Abort!)
**Key insight**: When an agent restarts, it wants to RESET its current turn, not ABORT it (which would pass control to the next agent).

Two approaches:

##### Option A: Reset with Marker Event
Add a system event that marks the turn as "reset" but doesn't close it:

```sql
-- Original events stay in place
seq=1 | turn=5 | "Processing..." | finality=none | agent=assistant
seq=2 | turn=5 | "Thinking..." | finality=none | agent=assistant

-- Add reset marker (NOT finality=turn!)
seq=3 | turn=5 | {"type":"turn_reset"} | finality=none | type=system

-- Same agent continues in SAME turn
seq=4 | turn=5 | "Processing..." | finality=none | agent=assistant
seq=5 | turn=5 | "Done!" | finality=turn | agent=assistant
```

##### Option B: Soft Reset (Recommended)
Don't add any event - just track reset state in memory/claims:

```typescript
class Orchestrator {
  private resetTurns = new Map<string, Set<number>>(); // conversation -> set of reset turns
  
  async resetTurn(
    conversationId: number,
    agentId: string
  ): Promise<{ turn: number; wasReset: boolean }> {
    const head = this.eventStore.getHead(conversationId);
    
    // Check if this agent owns the current open turn
    if (head.hasOpenTurn) {
      const lastEvent = this.eventStore.getLastEvent(conversationId);
      if (lastEvent?.agentId === agentId) {
        // Mark turn as reset in memory
        if (!this.resetTurns.has(`${conversationId}`)) {
          this.resetTurns.set(`${conversationId}`, new Set());
        }
        this.resetTurns.get(`${conversationId}`)!.add(head.lastTurn);
        
        return { turn: head.lastTurn, wasReset: true };
      }
    }
    
    return { turn: head.lastTurn + 1, wasReset: false };
  }
  
  // Modified sendMessage to handle resets
  async sendMessage(
    conversationId: number,
    agentId: string,
    payload: MessagePayload,
    finality: Finality,
    precondition?: TurnPrecondition
  ): Promise<UnifiedEvent> {
    const resetKey = `${conversationId}`;
    const resetTurns = this.resetTurns.get(resetKey);
    
    // Special handling for reset turns
    if (precondition && resetTurns?.has(precondition.expectTurn)) {
      // This is a reset turn - allow the agent to continue
      if (precondition.startingTurn) {
        // Clear the reset flag when agent starts fresh
        resetTurns.delete(precondition.expectTurn);
        
        // Allow continuing in the same turn number
        return this.eventStore.appendEvent({
          conversation: conversationId,
          type: 'message',
          payload,
          finality,
          agentId,
          turn: precondition.expectTurn // Reuse same turn!
        });
      }
    }
    
    // Normal validation for non-reset cases
    // ... existing validation logic ...
  }
}
```

### Implementation Approach: Turn Claims with Reset

Actually, the BEST approach leverages the existing turn claim system:

```typescript
class Orchestrator {
  async resetAndClaimTurn(
    conversationId: number,
    agentId: string,
    guidanceSeq: number
  ): Promise<{ success: boolean; turn: number }> {
    const head = this.eventStore.getHead(conversationId);
    
    // If there's an open turn by this agent, we can reset it
    if (head.hasOpenTurn) {
      const lastEvent = this.eventStore.getLastEvent(conversationId);
      if (lastEvent?.agentId === agentId) {
        // Agent owns this turn - they can reset and continue
        // Extend or refresh the claim
        this.turnClaimStore.refreshClaim(conversationId, guidanceSeq, agentId);
        
        // Add a trace event to mark the reset (optional, for debugging)
        await this.eventStore.appendEvent({
          conversation: conversationId,
          type: 'trace',
          payload: { 
            type: 'turn_reset',
            reason: 'agent_restart',
            timestamp: new Date().toISOString()
          },
          finality: 'none',
          agentId,
          turn: head.lastTurn
        });
        
        return { success: true, turn: head.lastTurn };
      }
    }
    
    // Otherwise try normal claim for next turn
    const claimed = await this.turnClaimStore.claim(
      conversationId, 
      guidanceSeq, 
      agentId
    );
    
    return { 
      success: claimed, 
      turn: claimed ? head.lastTurn + 1 : -1 
    };
  }
}
```

### Agent Usage Pattern

```typescript
class MyAgent {
  async handleTurn(ctx: AgentContext) {
    // Try to claim/reset the turn
    const claim = await ctx.transport.resetAndClaimTurn(
      ctx.conversationId,
      ctx.agentId,
      ctx.guidanceSeq
    );
    
    if (!claim.success) {
      // Another agent got it
      return;
    }
    
    // We have the turn (either fresh or reset)
    const turnNumber = claim.turn;
    
    // Start/restart with the turn we claimed
    await ctx.transport.postMessage({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      text: "Processing your request...",
      finality: 'none',
      precondition: {
        expectTurn: turnNumber,
        startingTurn: true
      }
    });
    
    // Do work...
    const result = await this.processRequest(ctx);
    
    // Complete turn
    await ctx.transport.postMessage({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      text: result,
      finality: 'turn',
      precondition: {
        expectTurn: turnNumber,
        startingTurn: false
      }
    });
  }
}
```

### Key Differences from Abort

| Abort Turn | Reset Turn |
|------------|------------|
| Closes the turn with tombstone | Keeps turn open |
| Triggers guidance for NEXT agent | Same agent continues |
| Gets new turn number | Reuses same turn number |
| For giving up | For retrying |

### Benefits

1. **No spurious guidance**: Resetting doesn't trigger other agents
2. **Clean restart**: Agent can wipe slate and retry
3. **Same turn number**: Conceptually it's still the same turn
4. **Works with claims**: Extends existing claim system

### Example Flows

#### Normal Flow
```
Turn 5: Assistant's turn
  → claim(turn=5) → success
  → postMessage({ expectTurn: 5, startingTurn: true })
  → postMessage({ expectTurn: 5, startingTurn: false, finality: 'turn' })
  → Guidance emitted for next agent
```

#### Restart Flow (Reset)
```
Turn 5: Assistant's turn
  → claim(turn=5) → success
  → postMessage({ expectTurn: 5, startingTurn: true })
  → [CRASH]
  
Assistant restarts:
  → resetAndClaimTurn() → success, turn=5 (SAME turn)
  → postMessage({ expectTurn: 5, startingTurn: true })  // Start fresh in same turn
  → postMessage({ expectTurn: 5, startingTurn: false, finality: 'turn' })
  → Guidance emitted for next agent
```

#### Abort Flow (When Giving Up)
```
Turn 5: Assistant's turn
  → claim(turn=5) → success
  → postMessage({ expectTurn: 5, startingTurn: true })
  → [Unrecoverable error]
  
Assistant gives up:
  → abortTurn() → adds tombstone with finality=turn
  → Guidance emitted for NEXT agent (not assistant)
```

## Summary

The key insight: **Reset vs Abort**
- **Reset**: "I messed up, let me try again" - same agent, same turn
- **Abort**: "I give up, someone else take over" - next agent, new turn

Combined with turn-based preconditions, this gives agents:
- Simple turn management
- Clean restart semantics  
- No spurious agent activations
- Clear mental model