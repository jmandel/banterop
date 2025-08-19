# A2A Client Generalization — Scenario-Aware Planner (Browser)

This document explains the new browser client direction that generalizes the A2A planner, the current implementation status, and what remains to be done.

## Goals
- Keep the existing A2A “two-pane” UI while replacing the old, monolithic planner with a simpler, event‑driven planner that:
  - Drives a single LLM step per trigger (user input, agent update, status change, file changes).
  - Emits a unified log of events with clear reasoning attached to each action.
  - Fetches scenario configuration and allows the user to pick which agent “we” play.
  - Dynamically exposes scenario synthesis tools, with user control to enable/disable them.
  - Resolves docId artifacts from tool outputs into concrete attachments before sending.

## Architecture (at a glance)
- UI layers
  - StepFlow (Connection/Configuration) stays; configuration now includes:
    - Scenario JSON URL (auto-loaded; agent selection persisted per-URL)
    - Enabled tools (checkbox list from scenario for selected agent)
    - Optional “Additional Planner Instructions” textarea
  - DualConversationView: unchanged; still shows User↔Planner and Planner↔Agent transcripts.
  - New EventLogView: read-only view of the unified planner event log (messages, tool calls/results, reasoning)

- Planner
  - `ScenarioPlannerV2` (src/frontend/a2a-client/planner-scenario.ts)
    - Event-driven loop; one LLM step per trigger.
    - UnifiedEvent log with attached reasoning per tool_call.
    - Reasoning+Action JSON contract: `{ reasoning, action: { tool, args } }` (tolerant parsing; code fences allowed; back-compat for `{ thought, toolCall }`).
    - Turn gating: sends to agent only when it’s allowed (no task yet or status=input-required).
    - Scenario context: identity, principal, system prompt, situation, goals, counterparts.
    - Available tools: always-available (sendMessage, askUser, sleep, done) + enabled synthesis tools from UI.
    - Available files: vault attachments plus any agent-provided attachments.

- Synthesis Tools
  - Enabled per UI; surfaced in prompt under “Synthesis tools (enabled)”.
  - Executed via `ToolSynthesisService` using a browser-side LLM provider (proxying to `/api/llm/complete`).
  - Results are logged and indexed for docId → attachment resolution.

- Attachments & Documents
  - `sendMessage` replaces any `attachments` with `docId` by building concrete A2A file parts (name, MIME, base64 bytes) from indexed documents.
  - Fallback to vault attachments by `name` when docId isn’t available.

## User Flow
1. Enter A2A endpoint URL; connect.
2. Paste a Scenario JSON URL. The client auto-loads agents and persists your chosen planner/counterpart per-URL.
3. Optionally un/check enabled synthesis tools and add “Additional Planner Instructions.”
4. Click “Begin Planner” — the planner attempts an initial LLM step and subscribes to updates.
5. Interact in the User↔Planner panel. The planner steps on each trigger and logs reasoning+actions in the Event Log.

## Prompting Model
- High-level sections embedded in the planner prompt:
  - `<SCENARIO>` — agent identity, principal, system prompt, situation, goals; counterparts listed.
  - `<ADDITIONAL_INSTRUCTIONS>` — free-form text from UI (optional).
  - `<CONVERSATION_HISTORY>` — unified events (messages, tool calls with inline `<reasoning>`, results).
  - `<CURRENT_TURN_LOG>` — scratchpad of thoughts + tool calls/results accumulated this session.
  - `<TOOLS>` —
    - Always available:
      - `sendMessage`: text + attachments (names MUST match AVAILABLE_FILES exactly); `finality?: 'turn'|'conversation'`.
      - `askUser`, `sleep`, `done`.
    - Synthesis tools (enabled only): name + description.
  - Response format: Return exactly one JSON object `{ reasoning, action: { tool, args } }` (fences tolerated).

## What’s Working
- Scenario-aware planner loop with unified events and reasoning+action JSON.
- Auto-load Scenario URL; per-URL persistence of selected planner/counterpart agent.
- Enabled tools UI; dynamic inclusion of enabled synthesis tools in the prompt.
- EventLogView showing tool calls (with reasoning), results, user messages, and agent messages.
- `sendMessage` resolves `docId` attachments to concrete file parts; falls back to vault by `name`.
- Initial planner step on “Begin Planner,” and after scenario loading.
- No token cap on planner ticks.

## What’s Partially Wired / Pending
- Synthesis tool execution:
  - Calls `ToolSynthesisService` with `BrowserLLMProvider` → `/api/llm/complete`.
  - Result is logged, and documents in the output are indexed.
  - TODO: Validate that all synthesis tool definitions used in scenarios include `synthesisGuidance` and any `inputSchema`. Extend output validation if needed.

- Scenario source unification:
  - Planner currently normalizes scenario from the A2A endpoint config.
  - UI loads Scenario JSON URL for agents/tools. In a future pass, pass the UI scenario (if present) into the planner as the canonical source.

- Persist enabled tools per-URL: currently not persisted; optional enhancement.

- Manual “Load” button: auto-load is active; we can remove the button or leave for explicit refresh.

- Prompt enrichment:
  - Already includes agent system prompt/situation/goals; can add more guidance (e.g., terminal tool expectations) to mirror `scenario-driven.agent.ts` more closely.

## Status Snapshot (Today)
- Planner loop and unified event log are stable in-browser; initial tick is triggered on start and after scenario load.
- Scenario URL auto-load and agent selection per-URL persistence are in place and working.
- Synthesis tools are surfaced in UI and included in the prompt when enabled; execution is routed through ToolSynthesisService using a browser-side LLM provider.
- sendMessage docId → attachment resolution works; event log shows the transformation clearly via tool_result → sendMessage.
- EventLogView provides transparent, read-only visibility into planner steps (reasoning + actions).

Known rough edges (expected UX gotchas):
- Enabled-tools default on first load depends on agent selection timing. If an agent is restored from storage, enabledTools may remain empty until the user toggles the agent picker. Defaulting this at scenario-load time will improve first-run UX.
- The manual "Load" button is redundant given auto-load; leaving it is harmless but can be confusing.
- BrowserLLMProvider is a minimal proxy (messages/temperature only). We don’t pass logging metadata/tools schemas; server observability is limited for synthesis calls.
- No schema validation on synthesis outputs; malformed outputs won’t get caught early.
- Event log can get long; there’s no filter/virtualization yet.

## Next Steps (Short-term, surgical)
1) Initialize enabledTools on scenario load
   - When the selected agent is restored (or defaulted), derive tool names and set enabledTools immediately (not only on agent change).
   - Persist enabledTools per-URL (like agent selection) to restore across reloads.

2) Tidy StepFlow props
   - Remove onLoadScenario={undefined} noise; keep prop truly optional.
   - Optionally hide/disable the manual Load button now that auto-load is active.

3) Improve prompt clarity
   - Ensure AVAILABLE_FILES is prominent and includes recent vault/synthesis artifacts.
   - Keep the explicit note that sendMessage attachments by name MUST match AVAILABLE_FILES.

4) Light polish
   - Unsubscribe EventLogView listener on stopPlanner to avoid stale updates.
   - Add a basic filter/toggle (e.g., show only tool_calls/tool_results) for large logs.

## Next Steps (Medium-term)
- Prefer UI-provided Scenario JSON in the planner
  - If a Scenario URL is configured, pass that config as the canonical scenario; fall back to endpoint-derived config only when absent.

- Strengthen tool synthesis
  - Pass loggingMetadata for better server-side traces.
  - Optionally add schema validation (tool.inputSchema) and a “repair” pass if invalid.
  - Persist doc artifacts created by synthesis to vault immediately (base64) so they appear in AVAILABLE_FILES without extra steps.

- Prompt enrichment
  - Bring over targeted guidance from scenario-driven.agent.ts (e.g., terminal tool exit semantics, outcome framing) where it adds clarity without bloating the prompt.

## Open Questions
- Should enabled tools be persisted per-URL and per-agent, or just per-URL?
- Do we want a hard limit on AVAILABLE_FILES count per prompt (to reduce LLM prompt size)? If so, what trimming strategy (LRU, priority flags)?
- Should we expose a compact XML prompt viewer in the UI for transparency and debugging?

## Rollout / Testing Notes
- Manual test checklist
  - Start planner with no existing task → initial tick; verify a `sleep/askUser` action is reasonable.
  - Send user message; verify planner ticks and event log shows reasoning + action.
  - Run a synthesis tool; verify tool_result contains structured output and any docId is indexed, then sendMessage with that docId.
  - Reload page; verify agent selection restores and, once implemented, enabled tools restore.
- Non-goals for MVP
  - Full schema validation and repair loops for synthesis outputs.
  - Advanced log filtering/virtualization.

## Known Limitations
- Synthesis service runs client-side via server proxy; heavy tool prompts could be slow.
- No schema validation for synthesis outputs (ToolSynthesisService warns this is a Connectathon-mode behavior).
- Error handling/reporting is basic; planner logs tool errors to the event log, but the UI does not yet surface a dedicated error panel.
- EventLogView is read-only and unfiltered; long runs could be verbose.

## Next Steps
- Prefer Scenario JSON URL data in the planner when present; treat endpoint-derived scenario as fallback.
- Persist enabled tools per-URL and restore across reloads.
- Remove/disable manual Load button.
- Add an “XML prompt view” toggle for transparency.
- Optional: Validate/stub outputs against each tool’s `inputSchema` and prompt the model to correct.
- Optional: Dedicated failure UI for synthesis tool errors.

## How to Use / Test
- Start the server (`bun run dev`) and frontend watcher (`bun run dev:frontend`).
- Open the A2A client (`/src/frontend/a2a-client/index.html`).
- Paste your A2A endpoint and Scenario JSON URL. The agent list auto-populates and persists per-URL.
- Toggle enabled tools, add optional instructions, and click “Begin Planner.”
- Use the left panel to send user messages and monitor the planner’s behavior in the Event Log.

## Rationale
This approach re-centers planning on a simple, transparent loop:
- One LLM step per trigger.
- One tool action per step.
- Reasoning for every action logged inline.
- Tools decoupled and exposed dynamically based on scenario + user selection.

It preserves the simplicity of the existing A2A UI while making the planner robust, inspectable, and scenario-driven.
