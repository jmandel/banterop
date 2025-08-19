# Conversation Watchdog (Design G)

Goal: add a server-side watchdog that runs on startup and every five minutes to cancel stalled conversations safely and predictably.

## Summary
- Runs on server startup and then on a fixed interval (default: 5 minutes).
- Detects stalled conversations using the authoritative event log.
- Cancels stalled conversations by appending a terminal message with outcome.status = `canceled`.
- Lives server-side; no client/UI participation required.

## Context
- Server entry: `src/server/index.ts` creates a singleton `App` (`src/server/app.ts`).
- Orchestrator: `src/server/orchestrator/orchestrator.ts` exposes storage and helpers (e.g., `endConversation`).
- Storage: `src/server/orchestrator/storage.ts` with `EventStore`, `ConversationStore` (SQLite schema in `src/db/schema.sql.ts`).
- Conversation events: `conversation_events` table with per-conversation `seq`, ISO `ts`, `finality`, and `agent_id`.

## Requirements
- Startup trigger: run immediately after resuming server-local agents.
- Steady cadence: run every 5 minutes (configurable).
- Safety: skip completed conversations; avoid overlapping runs; re-check before canceling.
- Determinism: rely on data from `EventStore` to decide open-turn/idle state.
- Observability: lightweight logs; optional metrics counters.
- Testability: provide a `runOnce()` method that can be invoked by tests.

## Stalled Definition
Primary criterion (on by default):
- Conversation status is `active` AND
- The current turn is open (`storage.events.getHead(convoId).hasOpenTurn === true`) AND
- Time since the last event `ts` > idle threshold (default 15 minutes).

Optional secondary criterion (off by default):
- Conversation status is `active` AND
- Last turn is closed AND
- No activity for longer than a global idle threshold (e.g., hours) → may auto-cancel long-idle but closed-turn conversations.

## Design & Placement
- New module: `src/server/control/conversation-watchdog.ts` exporting `ConversationWatchdog`.
- Lifecycle: constructed and started from `App` after seeding scenarios and `lifecycleManager.resumeAll()`.
- Shutdown: stopped from `App.shutdown()` alongside `orchestrator.shutdown()`.

### Class Shape
```ts
class ConversationWatchdog {
  constructor(opts: {
    orchestrator: OrchestratorService;
    storage: Storage;
    intervalMs: number;
    idleMs: number;
    globalIdleMs?: number; // optional
    enabled: boolean;
    logger?: (level: 'info'|'warn'|'error'|'debug', msg: string, meta?: any) => void;
  }) {}
  start(): void;
  stop(): void;
  runOnce(): Promise<{ checked: number; candidates: number; canceled: number }>;
}
```

### Scheduling
- On `start()`: if enabled, call `runOnce()` immediately (post-resume) and set `setInterval` for subsequent runs.
- Concurrency guard: boolean `isRunning`; skip a tick if a previous run is still in progress.

## Detection Algorithm
Per active conversation:
1) Get head: `const head = storage.events.getHead(conversationId)`.
2) If `!head.hasOpenTurn`, skip (unless optional global-idle mode is enabled).
3) Fetch last event `ts` quickly:
   - `SELECT ts, finality FROM conversation_events WHERE conversation = ? ORDER BY seq DESC LIMIT 1`.
4) If `now - new Date(ts)` > `idleMs`, mark as candidate.
5) Before canceling, re-read head and last event to avoid races (if updated/closed/finished, skip).

## Cancel Flow
- Optionally write advisory system event:
  - `orchestrator.appendEvent({ type: 'system', finality: 'none', agentId: 'system-watchdog', payload: { kind: 'idle_timeout', data: { lastEventTs } }, conversation })`.
- Close with terminal message:
  - `orchestrator.endConversation(conversation, { authorId: 'system-watchdog', text: 'Auto-canceled after idle timeout.', outcome: 'canceled', metadata: { reason: 'idle_timeout', lastEventTs } })`.
- Orchestrator and EventStore already ensure conversation completion flags.

## Configuration
Add to `src/server/config.ts` (Zod schema + env mapping):
- `WATCHDOG_ENABLED` (default: true except in test).
- `WATCHDOG_INTERVAL_MS` (default: 300_000 / 5 minutes).
- `WATCHDOG_IDLE_MS` (default: 900_000 / 15 minutes).
- `WATCHDOG_GLOBAL_IDLE_MS` (optional; default undefined/off).

App wiring in `src/server/app.ts`:
- Instantiate `ConversationWatchdog` with config.
- `start()` after `lifecycleManager.resumeAll()`.
- `stop()` from `App.shutdown()`.

## Observability
- Logs on start/stop, each run summary, and each cancellation (conversation id, last ts, thresholds).
- Counters returned by `runOnce()` for tests and debug.
- Optional dev-only debug route to trigger `runOnce()` manually (not required for MVP).

## Edge Cases & Safety
- Completed conversations: skipped by prefilter and guarded by EventStore.
- Empty conversation (no events): treated as not having an open turn; skipped by default.
- Races: double-check head and last event before canceling; bail if new activity appears.
- Resource use: iterate active conversations in manageable batches; future optimization can add a SQL filter for `updated_at`.

## Testing Strategy
- Integration tests under `tests/integration/` using an in-memory DB:
  - Cancels open-turn idle: create active convo, write message with finality `none`, backdate last event `ts`, `runOnce()`, expect final message with outcome.status `canceled`.
  - Does not cancel recent activity: same setup but `ts` within threshold.
  - Skips completed: conversation with final message; `runOnce()` should no-op.
  - No overlap: simulate long `runOnce()` via stub and ensure concurrent tick is skipped.
- Type checks: expand `ConfigSchema` and ensure strict type coverage.

## Rollout Plan
1) Add config keys with conservative defaults; disabled in `NODE_ENV=test`.
2) Implement `ConversationWatchdog` and wire into `App` startup/shutdown.
3) Add integration tests and validate via `bun test`.
4) Add minimal logs and verify behavior locally.
5) Optionally add a debug route for manual trigger in development.

## Open Questions
- Default thresholds: is 15 minutes for open-turn idle acceptable? (Current `IDLE_TURN_MS` is 120s, too aggressive for auto-cancel.)
- Should we introduce a non-terminal “idle noted” path before canceling? (Out of scope for MVP.)
- Include scenario-specific overrides (e.g., long-running scenarios)? (Future work.)

