# Planner Harness — Triggers, Coalescing, and Responsibilities

This document explains how the planner harness runs, what wakes it up, and how it avoids tight loops.

## Terms

- `schedulePlan()`: Lightweight, idempotent scheduler. Safe to call often — it coalesces bursts into a single pass.
- `runPlanningPass()`: One authoritative planning pass. Reads facts, evaluates triggers and guards, calls the planner, and commits output with CAS.

## Who calls what

- Controller: subscribes to the store and calls `schedulePlan()` whenever the journal head (`seq`) changes (and once at init). It has no logic beyond wiring.
- Harness: owns all triggers, guards, idempotence, coalescing, and committing of planner output.

## Coalescing

`schedulePlan()` sets a microtask to run a single `runPlanningPass()` and ignores further calls in the same tick. This prevents running multiple passes for a burst of facts.

## Triggers (harness-owned)

The harness wakes a planning pass in response to these journal changes:

- Status trigger: last `status_changed` became `input-required` (plan once per such status).
- Inbound trigger: a new public inbound message (`remote_received`), only if the latest public is inbound (we haven’t already responded).
- Whisper trigger: a new `user_guidance` fact.

No explicit tool triggers — tools are planner-internal; harness doesn’t need to watch `tool_result`.

## Guards (harness-owned)

- Status gate: Only plan when the latest status is `input-required`.
- Unsent compose gate: If any `compose_intent` exists with no `remote_sent` after it, don’t plan (park until approval or dismissal).
- Outstanding question: Surface it if present, but do not block planning if a new trigger arrives (e.g., inbound or whisper).
- Duplicate sleep gate: If planner output is exactly one `sleep` and the last fact is `sleep`, skip committing it.
- Optional duplicate compose gate: If planner proposes a `compose_intent` identical to the most recent unsent compose (same text + attachment names), skip committing it.

## Idempotence

The harness plans only once per logical trigger instance:

- Tracks `lastStatusPlannedSeq`, `lastInboundPlannedSeq`, and `lastWhisperPlannedSeq` and updates them after a successful commit.
- A planning pass proceeds only if the corresponding trigger’s seq is greater than the last planned seq.

## Planning pass flow

1. Read facts/head.
2. Compute latest status and last public message; detect trigger seqs (status/inbound/whisper).
3. If no triggers fired, or status ≠ `input-required`, return.
4. If there’s an unsent compose, return (park).
5. Build `PlanInput` and `PlanContext` (hud/newId/readAttachment/config) and call `planner.plan()`.
6. Apply output guards (skip redundant `sleep`, optional duplicate `compose_intent`).
7. CAS-append. On success, update last…PlannedSeq counters and handle post-commit UI hooks (e.g., open composer for compose, surface question).

## Planner vs Harness Responsibilities

- Planner (`planner.plan`): Reads facts and returns `ProposedFact[]` (e.g., `compose_intent`, `tool_call/result`, `agent_question`, `sleep`). It is pure and unaware of triggers, CAS, or scheduling.
- Harness (`runPlanningPass`): Decides if/when to run, enforces guards, commits output, and drives HUD/composer/question hooks. It owns all idempotence and coalescing.

## Controller Responsibilities

- Create the harness with store callbacks.
- Subscribe to store changes and call `schedulePlan()` on `seq` increments.
- Do not implement triggers/guards; never call `runPlanningPass()` directly.

## Config Stores (Setup UI)

- Each planner exposes a config companion on the exported planner object:
  - `createConfigStore({ llm, initial?: FullConfig }) => PlannerConfigStore`
  - `summarizeApplied?(config) => string` (optional, label remains for now)
  - `dehydrate(config: FullConfig) => Seed` (pure; no network)
  - `hydrate(seed: Seed, ctx?) => Promise<{ config: FullConfig; ready: boolean }>` (may fetch)
- The Setup card renders generically using `FieldState[]` from the store snapshot and calls `setField()` as the user types.
- `exportFullConfig()` returns `{ config, ready }` for persistence in `configByPlanner[plannerId]` and readiness in `readyByPlanner[plannerId]`.
- Current planners wired with config stores:
  - LLM Drafter
  - Scenario Planner v0.3

## Config Lifecycle (Generic UI + Store)

- Save & Apply: The Setup card calls `reconfigurePlanner({ config, ready, rewind:true })` on the app store.
  - Store updates `configByPlanner[plannerId]` and `readyByPlanner[plannerId]`.
  - Centralized URL sync dehydrates FullConfig and writes a human‑readable JSON hash with a monotonic `rev`.

- Deep-link bootstrap: On page load, `startUrlSync()` reads the readable JSON hash, sets planner id/mode, extracts a seed from `planners[<id>].seed` (or `planner.seed`/`seed` for tolerance), hydrates via the planner’s `hydrate()`, then commits `{ config, ready }` to the store.

- Harness wiring: The planner controller watches store changes and rebuilds the harness when `plannerId`, `readyByPlanner`, or `configByPlanner` change, passing the FullConfig directly to the harness.

## Deep-Linking Contract

- Planners should implement both hooks:
  - `dehydrate(config)` returns a small seed; exclude large fields and include only what’s needed to reconstruct intent.
  - `hydrate(seed, ctx)` returns `{ config, ready }` usable by the harness; may fetch and should preserve user choices when still valid.
- The generic store/UI do not read/write the URL directly — a centralized service coordinates both directions.

## `opts.initial` Convention (Planner Config Stores)

- Definition: `opts.initial` is the previously applied FullConfig (from the store or hydrated seed) passed into `createConfigStore({ llm, initial })`.
- Use: Each planner’s config store uses it to prefill fields and drive initialization behaviors. Stores define how to interpret `initial` and what to expose in `exportFullConfig()`.

## Scenario Planner v0.3 — Setup Behaviors

- Auto-load by URL: If `initial.scenarioUrl` is provided but `initial.resolvedScenario` is not, the scenario config store fetches and validates the JSON on mount (no extra user step).
- Preserve selections: On first derive after loading a scenario:
  - `myAgentId`: If provided in `initial` and valid for the loaded scenario, it’s kept; otherwise the first agent is selected.
  - `enabledTools`: If provided in `initial`, it is filtered to valid tools and used; otherwise defaults to “all tools” for the selected agent.
- One-time application: An internal `_appliedInitial` flag ensures initial selections apply once and are not overwritten on subsequent derives.
- Deep-link de/rehydration: The planner serializes only lightweight fields in `dehydrate(config)` (e.g., `{ scenarioUrl, model, myAgentId?, enabledTools?, enabledCoreTools?, maxInlineSteps? }`) and reconstructs FullConfig via `hydrate(seed)`.

## Responsibilities Recap

- Generic UI/Store:
  - Renders setup using generic fields; saves via `reconfigurePlanner({ config, ready })`.
  - A centralized URL sync dehydrates/hydrates using planner hooks.
  - Orchestrates harness lifecycle; no planner-specific logic.
- Planner Config Stores:
  - Define fields, validation, and dynamic options (e.g., load scenario, derive agents/tools).
  - Interpret `opts.initial`; return `{ applied, ready }`.
- Planner Implementations:
  - Implement `plan(input, ctx)` to produce journal facts.
  - Consume FullConfig directly via `ctx.config`.
