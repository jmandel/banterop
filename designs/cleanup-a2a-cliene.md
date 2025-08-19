# A2A Client Cleanup Plan

## Goals
- Simplify A2A client structure for clarity and maintainability
- Centralize side‑effects (SSE, persistence) into reusable hooks
- Keep a consistent, left‑aligned action flow and reduce UI clutter
- Improve error surfacing and resilience without changing core behavior

## Current State (Summary)
- `App.tsx` coordinates: connection, task streaming, planner orchestration, attachments, persistence, and UI
- Side‑effects spread across multiple `useEffect` blocks (endpoint changes, SSE, localStorage)
- Layout improved (Begin Planner prominent; attachments in planner; scenario “will change” banner; watch link), but responsibilities still mixed

## Design Principles
- Single responsibility per component and hook
- Deterministic UI state modeled at the top, effects encapsulated in hooks
- Readable, testable, progressively enhanced (small deltas per phase)

## Proposed Architecture

### Components
- `ConnectionBar`
  - Shows status, task ID, Open in Watch, Reset Client
  - Detects “our bridge” via same logic as `ScenarioDetector`
- `ConfigPanel`
  - Two textareas side‑by‑side (Background & Goals, Planner Instructions)
  - Begin/Stop Planner (prominent) + Planner mode/model selectors
  - Inline `AttachmentBar` (upload, summarize toggle, summarizer model)
- `ConversationsPanel`
  - Left: User ↔ Planner log and composer (inline “your turn now” badge)
  - Right: Planner ↔ Agent log (attachments open via API)
- `ScenarioDetector` (existing)
  - Prefetch + “will change” comparison; Load button only when effective

### Hooks
- `useA2AConnection(endpoint)`
  - Manages the A2A client instance and connectivity flags
- `useTaskStream(endpoint)`
  - Owns `A2ATaskClient` lifecycle (startNew/send/resubscribe/clearLocal)
  - Emits consolidated task snapshots to subscribers
- `useSessionState(endpoint)`
  - Load/save session snapshot: `{ taskId, status, plannerStarted, front, frontDraft }`
  - Single debounced saver; one loader on connect
- `usePlanner({ task, vault, getPolicy, getInstructions, getGoals })`
  - Starts/stops planner; exposes `recordUserReply`, internal event log
  - No UI side‑effects; emits to callers via callbacks (already present)
- `useAttachments()`
  - Encapsulates `AttachmentVault` interactions + summarizer queue

### Persistence & Effects
- Single effect to save session snapshot on meaningful changes
- SSE stream + resubscribe wrapped in a hook; cleanup on endpoint/task change
- LocalStorage writes debounced or change‑detected to avoid churn

### UX Improvements (non‑breaking)
- Keep primary actions on the left; reduce disabled controls in view
- Inline “your turn now” indicator (no log spam)
- Toast/status line for common errors (stream disconnect, send failure)
- Optional scenario preview tooltip

### Error Handling
- Map transport and server errors to concise user messages
- Continue best‑effort (don’t derail planner flow on non‑critical errors)

## Phased Plan

1) Structure (low risk)
- Extract components: `ConnectionBar`, `ConfigPanel`, `ConversationsPanel`
- Move existing code as‑is; pass props through `App.tsx`

2) Hooks for side‑effects
- Add `useTaskStream` for `A2ATaskClient` + SSE resubscribe (with cleanup)
- Add `useSessionState` to unify load/save; remove scattered localStorage effects
- Wire `useA2AConnection` to normalize endpoint connect/disconnect

3) Planner integration
- Add `usePlanner` shim around existing `Planner`; keep callbacks and gating logic
- Keep UI behavior identical (Begin/Stop, ask user path)

4) Attachments
- Add `useAttachments` (vault, summarize toggle/model) and use inside `ConfigPanel`

5) UX polish + errors
- Add a lightweight toast/status for errors
- Ensure composer focuses on “input‑required” transition
- Verify keyboard flows (Enter to send; shift+Enter reserved)

6) Tests & docs
- Add unit tests for `useSessionState` (load/save), `ScenarioDetector` “will change” logic, and reset flow
- Update README snippet for A2A client + design notes here

## Risks & Mitigations
- Behavior drift: move logic first, then refactor internals; add tests
- SSE cleanup leaks: centralize in a hook with teardown on deps change
- LocalStorage inconsistencies: single writer; schema bump guarded by keys

## Acceptance Criteria
- No regressions in sending/streaming, planner flow, attachments, watch link
- Session persists and restores cleanly, including planner running state
- Components are focused; hooks encapsulate effects; code is easier to read

## Out‑of‑Scope (for now)
- Virtualization of long logs
- Full markdown/JSON diff viewers for tool results
- Multi‑endpoint session management UI

