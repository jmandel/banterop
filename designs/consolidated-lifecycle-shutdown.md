# Consolidated Lifecycle Shutdown Design

## Problem Statement

Currently, agent lifecycle management (stopping agents when conversations end) is scattered across multiple components:

1. **A2A Server**: Explicitly calls `lifecycle.stop()` when canceling tasks
2. **Watchdog**: Calls `lifecycle.stop()` before canceling timed-out conversations  
3. **JSON-RPC Server**: Has its own subscription to stop agents on conversation completion
4. **Manual cleanup**: Required in various error paths

This distributed approach leads to:
- Code duplication
- Inconsistent error handling
- Potential race conditions
- Missed cleanup scenarios
- Harder testing and maintenance

## Proposed Solution

Consolidate all automatic agent cleanup into the `ServerAgentLifecycleManager` by having it subscribe to orchestrator events and automatically stop agents when conversations reach terminal states.

## Implementation

### 1. Add Event Subscription to Lifecycle Manager

```typescript
// In ServerAgentLifecycleManager
class ServerAgentLifecycleManager implements IAgentLifecycleManager {
  private orchestratorSubId?: string;

  async initialize(orchestrator: OrchestratorService) {
    // Subscribe to ALL conversation events
    this.orchestratorSubId = orchestrator.subscribe(
      -1, // All conversations
      async (event: UnifiedEvent) => {
        // Only handle message events with conversation finality
        if (event.type === 'message' && event.finality === 'conversation') {
          await this.handleConversationEnd(event);
        }
      },
      false // Don't need guidance events
    );
  }

  private async handleConversationEnd(event: UnifiedEvent) {
    const conversationId = event.conversation;
    console.log(`[Lifecycle] Auto-stopping agents for completed conversation ${conversationId}`);
    
    try {
      await this.stop(conversationId);
      console.log(`[Lifecycle] Successfully stopped agents for conversation ${conversationId}`);
    } catch (e) {
      // Log but don't throw - cleanup is best-effort
      console.error(`[Lifecycle] Failed to stop agents for conversation ${conversationId}:`, e);
    }
  }

  async shutdown() {
    // Unsubscribe when shutting down
    if (this.orchestratorSubId) {
      this.orchestrator?.unsubscribe(this.orchestratorSubId);
      this.orchestratorSubId = undefined;
    }
  }
}
```

### 2. Remove Redundant Code

#### A2A Server (`src/server/bridge/a2a-server.ts`)

**Before:**
```typescript
private async handleTasksCancel(params: any) {
  // ... send cancellation message ...
  
  try { await this.deps.lifecycle.stop(taskNum); } catch {}
  
  return this.buildTask(taskNum, externalId, 'canceled');
}
```

**After:**
```typescript
private async handleTasksCancel(params: any) {
  // ... send cancellation message with finality: 'conversation' ...
  // No explicit lifecycle.stop() needed - auto-cleanup will handle it
  
  return this.buildTask(taskNum, externalId, 'canceled');
}
```

#### Watchdog (`src/server/watchdog/conversation-watchdog.ts`)

**Before:**
```typescript
private async cancelStalledConversation(conversationId: number) {
  try {
    await this.lifecycleManager.stop(conversationId);
    console.log(`[Watchdog] Stopped agents for conversation ${conversationId}`);
  } catch (error) {
    console.error(`[Watchdog] Failed to stop agents for ${conversationId}:`, error);
  }
  
  // ... append cancellation events ...
}
```

**After:**
```typescript
private async cancelStalledConversation(conversationId: number) {
  // Just append the cancellation message with finality: 'conversation'
  // Auto-cleanup will handle agent shutdown
  
  // ... append cancellation events ...
}
```

#### JSON-RPC Server (`src/server/ws/jsonrpc.server.ts`)

**Remove entirely:**
```typescript
// DELETE THIS BLOCK:
orchestrator.subscribeAll((e: UnifiedEvent | GuidanceEvent) => {
  if ('type' in e && e.type === 'message') {
    const m = e as UnifiedEvent;
    if (m.finality === 'conversation') {
      lifecycle.stop(m.conversation).catch(() => {});
    }
  }
}, false);
```

## Benefits

### Code Reduction
- ~30 lines of redundant cleanup code removed
- Single subscription instead of multiple
- Centralized error handling

### Consistency
- All conversation endings handled identically
- Same logging and error recovery pattern
- No missed scenarios

### Maintainability
- Single source of truth for agent cleanup
- Easier to test (one place to verify)
- Clear separation of concerns

### Reliability
- Fewer race conditions
- Guaranteed cleanup for all terminal states
- Best-effort error handling won't break conversation flow

## Triggered By

The auto-shutdown will be triggered by ANY message with `finality: 'conversation'`, including:

1. **Normal completion**: Agent completes conversation normally
2. **Cancellation**: Client cancels via A2A API
3. **Timeout**: Watchdog cancels idle conversations  
4. **Max turns**: Orchestrator auto-closes at turn limit
5. **System errors**: Any system component closing conversation
6. **Failed state**: If failure includes conversation finality

## Edge Cases

### Race Conditions
- Multiple events may trigger cleanup for same conversation
- Solution: `lifecycle.stop()` is idempotent - safe to call multiple times

### Startup Order
- Lifecycle manager must be initialized AFTER orchestrator
- Solution: Add `initialize()` method called during server startup

### Shutdown Order  
- Must unsubscribe before orchestrator shuts down
- Solution: Add `shutdown()` method to lifecycle manager

### Already Stopped Agents
- Agents may already be stopped when cleanup runs
- Solution: `stop()` gracefully handles missing agents

## Testing Strategy

1. **Unit Tests**: Mock orchestrator, verify subscription and cleanup calls
2. **Integration Tests**: Verify agents stop for all termination scenarios
3. **Error Tests**: Verify cleanup failures don't break conversation flow
4. **Race Tests**: Verify multiple cleanup attempts are safe

## Migration Path

1. Add subscription logic to lifecycle manager
2. Deploy and verify auto-cleanup works
3. Remove redundant manual cleanup calls
4. Monitor for any missed cleanup scenarios

## Future Enhancements

Could extend to handle:
- Partial agent shutdown (stop specific agents mid-conversation)
- Graceful shutdown with timeout before force-stop
- Metrics on cleanup success/failure rates
- Configurable cleanup strategies per conversation type