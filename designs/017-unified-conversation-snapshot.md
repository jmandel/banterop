# 017-unified-conversation-snapshot

## Goal
Replace split “snapshot vs. hydrated snapshot” with a single, first-class conversation snapshot that can optionally include scenario config, eliminate title/description duplication, and add a strict flag to require scenario presence when requested.

## Scope
- Unify to one type: `ConversationSnapshot` with optional `scenario`.
- Provide one orchestrator method to fetch snapshot with optional scenario inclusion and strictness.
- Normalize where `title`/`description`/`scenarioId` live (no duplication in metadata).
- Update transports, WS RPC, agents, and tests.
- Touch `updated_at` on event append for freshness.

## Non-Goals
- Backward compatibility shims.
- Changing event schema or finality semantics.
- Streaming protocol redesign.

## Current State
- Two types: `ConversationSnapshot` and `HydratedConversationSnapshot`.
- `conversations` table has `title`, `description`, `scenario_id`, `meta_json` (for `{agents,config,custom}`).
- `getWithMetadata` projects `title/description/scenarioId` into `metadata`, causing duplication.
- WS `getConversation` returns non-hydrated; separate `getHydratedConversation` exists.
- `updated_at` changes only on conversation row updates, not on event inserts.

## Decisions
### Single Type
Keep one `ConversationSnapshot`:
- Fields: 
  - `conversation: number`
  - `status: 'active' | 'completed'`
  - `title?: string`
  - `description?: string`
  - `scenarioId?: string`
  - `metadata: { agents: AgentMeta[]; config?: Record<string, unknown>; custom?: Record<string, unknown> }`
  - `events: UnifiedEvent[]`
  - `scenario?: ScenarioConfiguration`

### Single Method
Orchestrator: `getConversationSnapshot(id, opts?)`
- `opts?: { includeScenario?: boolean; requireScenarioIfConfigured?: boolean }`
- Default: include scenario if configured.
- If `scenarioId` is set but scenario is missing and `requireScenarioIfConfigured===true`, throw.

### Data Placement
- Keep `title`, `description`, `scenarioId` at the conversation row (top‑level).
- `metadata` strictly holds `{ agents, config, custom }` only.
- No projection of title/description/scenarioId into `metadata`.

### Freshness
- Ensure `conversations.updated_at` is touched on every `conversation_events` insert via DB trigger.

## API Changes
### Types
- Remove `HydratedConversationSnapshot`.
- Update all references to use unified `ConversationSnapshot`.
- Ensure `metadata` only contains agents/config/custom.

### Orchestrator
- Replace `getHydratedConversationSnapshot` and current `getConversationSnapshot` with unified method (signature above).

### WS RPC
- `getConversation(params: { conversationId: number; includeScenario?: boolean; requireScenarioIfConfigured?: boolean })` returns unified snapshot.
- Remove `getHydratedConversation` RPC.

### Transports
- `WsTransport.getSnapshot` forwards include flags and expects unified snapshot.
- `InProcessTransport.getSnapshot` calls new unified method.

### Agents
- Scenario‑driven agent reads `snapshot.scenario?` where needed.
- Update tests/mocks to the unified type.

## Storage Changes
### Schema Trigger
- Add trigger on `conversation_events` INSERT to update `conversations.updated_at` for that `conversation`.


## Migration & Refactors
- Remove the old hydrated method/type.
- Update WS server handlers to the unified call and flags.
- Update tests expecting `metadata.title/description/scenarioId` to assert them at root level.
- Adjust UI to read `title/description` from root, `metadata` for agents/config/custom.
- Keep `WsEventStream`/backlog logic unchanged (only snapshot shape changes).

## Risks
- Widespread type changes touching tests and mocks.
- Over‑fetching scenarios by default; mitigated by flags (and default behavior still matches “include if configured”).
- Strict errors when scenario missing and `requireScenarioIfConfigured` is true (intended).

## Rollout Steps
1. Update types and Orchestrator unified method.
2. Wire WS RPC to unified snapshot and flags.
3. Fix transports (in‑process and WS).
4. Update ConversationStore to stop projecting title/description/scenarioId into metadata.
5. Add DB trigger for `updated_at` on event insert.
6. Update agents/tests/mocks.
7. Run `bun test` and `bun run typecheck`.

## Acceptance Criteria
- Single snapshot type used throughout; no `HydratedConversationSnapshot`.
- `getConversationSnapshot` returns scenario when requested and present; errors when strictly required but missing.
- No duplication of title/description/scenarioId in `metadata`.
- `updated_at` reflects recent event activity.
- All tests and type checks pass.

