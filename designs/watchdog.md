# Conversation Watchdog Design

## Overview
A background service that monitors active conversations and automatically cancels those that have stalled, preventing resource leaks and ensuring system health.

## Problem Statement
- Conversations can become stuck due to agent failures, network issues, or logic errors
- Stalled conversations consume resources (database entries, potential memory/CPU if agents are running)
- No current mechanism to automatically clean up inactive conversations
- Manual intervention required to identify and cancel stuck conversations

## Design Goals
1. **Automatic detection** of stalled conversations based on configurable criteria
2. **Clean cancellation** that properly stops agents and updates conversation state
3. **Minimal performance impact** on the running system
4. **Observable behavior** through logging and metrics
5. **Configurable and disableable** for different deployment scenarios

## Detection Criteria

A conversation is considered stalled when ALL of the following are true:
- Status is `'active'` (not completed)
- No new events for > `stalledThresholdMs` (default: 10 minutes)
- Has been active for > `minAgeMs` (default: 2 minutes) to avoid canceling new conversations

Additional future criteria to consider:
- Agent in "ensure-running" state but not producing events
- Repeated failures in agent turns
- Explicit timeout set on conversation creation

## Architecture

### Component Structure
```
src/server/
├── watchdog/
│   ├── conversation-watchdog.ts    # Main watchdog service
│   ├── watchdog.types.ts          # Type definitions
│   └── watchdog.test.ts           # Unit tests
└── app.ts                          # Integration point
```

### Class Design

```typescript
// watchdog.types.ts
export interface WatchdogConfig {
  enabled: boolean;              // Enable/disable watchdog
  intervalMs: number;            // Check interval (default: 5 minutes)
  stalledThresholdMs: number;    // Inactivity threshold (default: 10 minutes)
  minAgeMs: number;             // Min age before eligible (default: 2 minutes)
  startupDelayMs: number;        // Delay before first check (default: 30 seconds)
  maxCancellationsPerRun: number; // Rate limit (default: 10)
}

export interface WatchdogStats {
  lastCheckTime: Date;
  conversationsChecked: number;
  conversationsCanceled: number;
  errors: number;
}

// conversation-watchdog.ts
export class ConversationWatchdog {
  private intervalHandle?: Timer;
  private stats: WatchdogStats;
  private isRunning: boolean = false;
  
  constructor(
    private storage: Storage,
    private orchestrator: OrchestratorService,
    private lifecycleManager: ServerAgentLifecycleManager,
    private config: WatchdogConfig
  ) {
    this.stats = {
      lastCheckTime: new Date(),
      conversationsChecked: 0,
      conversationsCanceled: 0,
      errors: 0
    };
  }
  
  start(): void
  stop(): void
  getStats(): WatchdogStats
  private checkStalled(): Promise<void>
  private isStalled(convo: Conversation): Promise<boolean>
  private cancelStalledConversation(conversationId: number): Promise<void>
}
```

## Implementation Details

### 1. Startup Sequence
```typescript
// In App constructor
constructor(options?: AppOptions) {
  // ... existing initialization ...
  
  const watchdogConfig = this.configManager.get().watchdog;
  if (watchdogConfig?.enabled !== false) {
    this.watchdog = new ConversationWatchdog(
      this.storage,
      this.orchestrator,
      this.lifecycleManager,
      watchdogConfig || DEFAULT_WATCHDOG_CONFIG
    );
    
    // Delay startup to let system stabilize
    setTimeout(() => {
      console.log('[Watchdog] Starting conversation watchdog');
      this.watchdog?.start();
    }, watchdogConfig?.startupDelayMs || 30000);
  }
}
```

### 2. Stalled Detection Algorithm
```typescript
private async checkStalled(): Promise<void> {
  if (this.isRunning) {
    console.log('[Watchdog] Check already in progress, skipping');
    return;
  }
  
  this.isRunning = true;
  const startTime = Date.now();
  
  try {
    // Get all active conversations
    const activeConvos = this.storage.conversations.list({ 
      status: 'active',
      limit: 1000 // Safety limit
    });
    
    console.log(`[Watchdog] Checking ${activeConvos.length} active conversations`);
    this.stats.conversationsChecked += activeConvos.length;
    
    const stalledConvos: number[] = [];
    
    for (const convo of activeConvos) {
      if (await this.isStalled(convo)) {
        stalledConvos.push(convo.conversation);
        
        // Rate limiting
        if (stalledConvos.length >= this.config.maxCancellationsPerRun) {
          console.log('[Watchdog] Reached max cancellations per run');
          break;
        }
      }
    }
    
    // Cancel stalled conversations
    for (const convId of stalledConvos) {
      await this.cancelStalledConversation(convId);
    }
    
    const duration = Date.now() - startTime;
    console.log(`[Watchdog] Check complete in ${duration}ms, canceled ${stalledConvos.length} conversations`);
    
  } catch (error) {
    console.error('[Watchdog] Error during check:', error);
    this.stats.errors++;
  } finally {
    this.isRunning = false;
    this.stats.lastCheckTime = new Date();
  }
}

private async isStalled(convo: Conversation): Promise<boolean> {
  try {
    // Check age
    const createdAt = new Date(convo.createdAt).getTime();
    const age = Date.now() - createdAt;
    if (age < this.config.minAgeMs) {
      return false; // Too young
    }
    
    // Check last event time
    const head = this.storage.events.getHead(convo.conversation);
    if (!head.lastSeq) {
      // No events at all, but old enough - consider stalled
      return true;
    }
    
    // Get the last event to check its timestamp
    const lastEvent = this.storage.events.getEventBySeq(
      convo.conversation, 
      head.lastSeq
    );
    
    if (!lastEvent) {
      return false; // Shouldn't happen
    }
    
    const lastEventTime = new Date(lastEvent.ts).getTime();
    const timeSinceLastEvent = Date.now() - lastEventTime;
    
    return timeSinceLastEvent > this.config.stalledThresholdMs;
    
  } catch (error) {
    console.error(`[Watchdog] Error checking conversation ${convo.conversation}:`, error);
    return false; // Don't cancel on errors
  }
}
```

### 3. Cancellation Process
```typescript
private async cancelStalledConversation(conversationId: number): Promise<void> {
  console.log(`[Watchdog] Canceling stalled conversation ${conversationId}`);
  
  try {
    // 1. Stop any running agents (gracefully)
    try {
      await this.lifecycleManager.stop(conversationId);
      console.log(`[Watchdog] Stopped agents for conversation ${conversationId}`);
    } catch (error) {
      console.error(`[Watchdog] Failed to stop agents for ${conversationId}:`, error);
      // Continue with cancellation even if agent stop fails
    }
    
    // 2. Get current turn info for the cancellation event
    const head = this.storage.events.getHead(conversationId);
    const nextTurn = head.hasOpenTurn ? head.lastTurn : head.lastTurn + 1;
    
    // 3. Append system cancellation event
## Cancel Flow
- Optionally write advisory system event:
  - `orchestrator.appendEvent({ type: 'system', finality: 'none', agentId: 'system-watchdog', payload: { kind: 'idle_timeout', data: { lastEventTs } }, conversation })`.
- Close with terminal message:
  - `orchestrator.endConversation(conversation, { authorId: 'system-watchdog', text: 'Auto-canceled after idle timeout.', outcome: 'canceled', metadata: { reason: 'idle_timeout', lastEventTs } })`.
- Orchestrator and EventStore already ensure conversation completion flags.

   
    // 4. The finality:'conversation' in the event above will trigger
    // the orchestrator to mark the conversation as completed
    
 console.log('[App] Shutting down...');
  
  // Stop watchdog first to prevent new cancellations during shutdown
  if (this.watchdog) {
    console.log('[Watchdog] Stopping watchdog');
    this.watchdog.stop();
    
    // Log final stats
    const stats = this.watchdog.getStats();
    console.log('[Watchdog] Final stats:', stats);
  }
  
  // Then shutdown other services
  await this.orchestrator.shutdown();
  this.storage.close();
}
```

## Configuration

### Default Configuration
```typescript
const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  enabled: true,
  intervalMs: 5 * 60 * 1000,        // 5 minutes
  stalledThresholdMs: 10 * 60 * 1000, // 10 minutes
  minAgeMs: 2 * 60 * 1000,          // 2 minutes
  startupDelayMs: 30 * 1000,        // 30 seconds
  maxCancellationsPerRun: 10        // Rate limit
};
```

### Environment Variables
```bash
# Disable watchdog entirely
WATCHDOG_ENABLED=false

# Adjust timing (milliseconds)
WATCHDOG_INTERVAL_MS=300000          # Check every 5 minutes
WATCHDOG_STALLED_THRESHOLD_MS=600000 # Consider stalled after 10 minutes
WATCHDOG_MIN_AGE_MS=120000          # Don't cancel conversations younger than 2 minutes

# Rate limiting
WATCHDOG_MAX_CANCELLATIONS=10       # Max conversations to cancel per check
```

### Per-Conversation Overrides (Future)
```typescript
// In ConversationMeta
interface ConversationMeta {
  // ... existing fields ...
  watchdog?: {
    disabled?: boolean;           // Disable watchdog for this conversation
    stalledThresholdMs?: number; // Custom timeout for this conversation
  };
}
```

## Testing Strategy

### Unit Tests
1. **Detection logic**: Test `isStalled()` with various conversation states
2. **Rate limiting**: Ensure max cancellations is respected
3. **Age filtering**: Verify young conversations aren't canceled
4. **Error handling**: Test behavior when storage/orchestrator operations fail

### Integration Tests
1. **End-to-end cancellation**: Create stalled conversation, run watchdog, verify cleanup
2. **Agent stopping**: Verify agents are properly stopped before cancellation
3. **Event generation**: Check system events are properly created
4. **Concurrent operations**: Test watchdog running while conversations are active

### Manual Testing Checklist
- [ ] Start app with watchdog enabled
- [ ] Create a conversation and let it stall
- [ ] Verify watchdog cancels it after threshold
- [ ] Check logs for proper messages
- [ ] Verify agents are stopped
- [ ] Check database state is consistent
- [ ] Test with watchdog disabled
- [ ] Test startup delay works correctly

## Monitoring & Observability

### Metrics to Track
- `watchdog.checks.total` - Total number of watchdog runs
- `watchdog.conversations.checked` - Conversations examined
- `watchdog.conversations.canceled` - Conversations canceled
- `watchdog.errors.total` - Errors encountered
- `watchdog.duration.ms` - Time taken per check

### Log Messages
```
[Watchdog] Starting conversation watchdog
[Watchdog] Checking 5 active conversations
[Watchdog] Canceling stalled conversation 123
[Watchdog] Stopped agents for conversation 123
[Watchdog] Successfully canceled conversation 123
[Watchdog] Check complete in 150ms, canceled 2 conversations
[Watchdog] Error during check: <error details>
```

### Health Check
```typescript
// Expose watchdog stats in health endpoint
app.get('/health', (c) => {
  const watchdogStats = app.watchdog?.getStats();
  return c.json({
    status: 'healthy',
    watchdog: watchdogStats || { enabled: false }
  });
});
```

## Rollout Plan

### Phase 1: Basic Implementation
- Core watchdog service
- Basic stalled detection (time-based only)
- Integration with App lifecycle
- Logging

### Phase 2: Enhanced Detection
- Add conversation age filtering
- Rate limiting
- Per-conversation timeout overrides
- Better error handling

### Phase 3: Observability
- Metrics collection
- Health check integration
- Admin UI for monitoring
- Alerting on high cancellation rates

### Phase 4: Advanced Features
- Graceful cancellation with warning events
- Smart detection (repeated failures, etc.)
- Conversation resurrection/retry
- Historical analysis of cancellation patterns

## Security Considerations
- Watchdog should not expose conversation content in logs
- Rate limiting prevents runaway cancellations
- Cancellation events are auditable via system events
- No external API endpoints - internal service only

## Performance Considerations
- Database queries should be indexed on `status` and `updated_at`
- Batch operations where possible
- Configurable check interval to balance responsiveness vs load
- Early exit from checks if system is under load

## Alternative Approaches Considered

### 1. Event-Driven Approach
Instead of polling, use timers per conversation. Rejected because:
- Complex timer management
- Memory overhead for many conversations
- Harder to implement rate limiting

### 2. Database Triggers
Use database triggers to detect stalled conversations. Rejected because:
- Database-specific implementation
- Harder to test and debug
- Less flexible cancellation logic

### 3. External Monitoring Service
Separate service that monitors via API. Rejected because:
- Additional deployment complexity
- Network overhead
- Requires exposing internal state via API

## Open Questions
1. Should we notify agents before canceling? (graceful shutdown period)
2. Should canceled conversations be resumable?
3. How to handle conversations that are intentionally long-running?
4. Should we track patterns to identify problematic scenarios?
5. Integration with error recovery mechanisms?

## Implementation Checklist
- [ ] Create watchdog directory structure
- [ ] Implement ConversationWatchdog class
- [ ] Add WatchdogConfig to ConfigManager
- [ ] Integrate with App lifecycle
- [ ] Write unit tests
- [ ] Write integration tests
- [ ] Add logging
- [ ] Update documentation
- [ ] Add metrics (future)
- [ ] Deploy and monitor in staging
- [ ] Roll out to production
