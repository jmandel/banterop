API Reference

This document summarizes the public HTTP (REST) routes, WebSocket JSON‑RPC methods, and the internal/in‑process client APIs available in this repository. It is intended for developers building UIs, CLIs, or agents that integrate with the server, as well as those embedding the orchestrator directly in‑process.

Base URLs
- REST base: `http://<host>:<port>/api`
- WebSocket base: `ws://<host>:<port>/api/ws`

Note: The server defaults to `PORT=3000` when running `bun run dev`.

Control vs Data Plane
- Control Plane (launch/inspect/ensure/stop): Thin, explicit surface to create/list conversations and manage server‑managed agents. Typically used via `WsControl` in the browser or in‑process on the server. See README “Control vs Data Plane” for an overview.
  - WS: `createConversation`, `getConversation`, `ensureAgentsRunningOnServer`, `stopAgentsOnServer`.
  - REST: `/api/conversations` (list), `/api/scenarios/*` (CRUD), `/api/attachments/*` (fetch).

 - Data Plane (agents talk): Append messages/traces and observe events. Used by transports (`WsTransport`, `InProcessTransport`). The orchestrator evaluates scheduling policy and emits guidance with a `kind` (`start_turn` or `continue_turn`). Agents act only on guidance and may use `clearTurn` to restart an open turn they own when recovering.
  - WS: `sendMessage`, `sendTrace`, `subscribe`, `unsubscribe`, `getEventsPage`, and `clearTurn`.

See README.md for more on recovery semantics and launch recipes.

REST API
- GET `/health`: Health check.
  - Purpose: Simple readiness probe.
  - Response: `{ ok: true }`.

- Scenarios CRUD (Scenario Store)
  - GET `/scenarios`
    - Purpose: List all stored scenarios.
    - Response: `Array<{ id, name, config, history }>`.
  - GET `/scenarios/:id`
    - Purpose: Fetch a scenario by ID.
    - 404 if not found.
  - POST `/scenarios`
    - Purpose: Create a new scenario.
    - Body: `{ name: string, config: ScenarioConfiguration, history?: any[] }` where `config.metadata.id` is required.
    - 201 on success; 409 if `id` exists; 400 on validation error.
  - PUT `/scenarios/:id`
    - Purpose: Update an existing scenario.
    - Body: `{ name?: string, config?: ScenarioConfiguration }`.
    - 404 if not found.
  - DELETE `/scenarios/:id`
    - Purpose: Delete a scenario.
    - Response: `{ success: true, deleted: id }` or 404.

- Attachments
  - GET `/attachments/:id`
    - Purpose: Fetch attachment metadata from a conversation event.
    - Response: `{ id, conversation, turn, event, docId?, name, contentType, content, summary?, createdByAgentId, createdAt }`.
  - GET `/attachments/:id/content`
    - Purpose: Stream raw attachment content.
    - Response: Binary body with `Content-Type` and `Content-Disposition` set.

- LLM helper
  - GET `/llm/providers`
    - Purpose: Enumerate available LLM providers and defaults.
  - POST `/llm/complete`
    - Purpose: One‑shot, non‑streaming completion via configured providers.
    - Body (validated):
      - `messages: Array<{ role: 'system'|'user'|'assistant', content: string }>`
      - `model?: string`, `temperature?: number (0..2)`, `maxTokens?: number`,
      - `tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>`
      - `provider?: 'google' | 'openrouter' | 'mock' | 'browserside'` (server‑side routing override; no API keys accepted via client)
    - Responses:
      - 200: `LLMResponse` (provider‑specific normalized shape; see `src/llm/providers/*`).
      - 400: `{ error: 'ValidationError', details }`.
      - 502: `{ error: 'ProviderError', message }`.

- MCP Bridge (HTTP JSON‑RPC under REST base)
  - ALL `/api/bridge/:config64/mcp`
    - Purpose: MCP‑compatible bridge endpoint using base64url ConversationMeta templates.
    - `:config64` is a base64url‑encoded ConversationMeta; see `src/server/bridge/conv-config.types.ts`.
    - Tools (server mode):
      - `begin_chat_thread`
        - Action: Creates a local conversation from the template.
        - Persistence: Ensures internal agents on the server via the runner registry so they survive restarts.
        - Result: `{ conversationId: string }` (string id on the wire).
      - `send_message_to_chat_thread`
        - Input: `{ conversationId: string, message: string, attachments?: Array<{ name, contentType, content, summary?, docId? }> }`
        - Action: Posts a message as the external client.
        - Result: `{ ok: true, guidance: string, status: 'waiting' }` — return advises to call `check_replies` (e.g., with `waitMs=10000`).
      - `check_replies`
        - Input: `{ conversationId: string, waitMs?: number (default 10000), max?: number (default 200) }`
        - Action: Returns replies since your last external message (messages‑only view).
        - Result: `{ messages: Array<{ from: string; at: ISOString; text: string; attachments?: Array<{ name: string; contentType: string; summary?: string; docId?: string }> }>, guidance: string, status: 'input_required'|'waiting', conversation_ended: boolean }`
    - Notes:
      - Wire type: `conversationId` is a string on the wire (numeric id serialized as string).
      - Envelope: JSON‑RPC results place payload in `result.content[0].text` as JSON string.
      - Discovery: conversations created by the bridge are stamped with `metadata.custom.bridgeConfig64Hash = base64url(sha256(config64))` for matching in UIs.
  - GET `/api/bridge/:config64/mcp/diag`
    - Purpose: Decode and inspect `config64` (diagnostics).

WebSocket JSON‑RPC API (`/api/ws`)
- Connection lifecycle
  - On open: Server sends `{ jsonrpc: '2.0', method: 'welcome', params: { ok: true } }`.
  - Notifications: Server pushes events with method `'event'` (UnifiedEvent) and `'guidance'` (GuidanceEvent) to subscribed clients.

- Methods and payloads
  - `ping`
    - Params: none
    - Result: `{ ok: true, ts: ISOString }`

  - `createConversation`
    - Params: `{ meta: ConversationMeta }` (see types below)
    - Result: `{ conversationId: number, title?: string }`

  - `getConversation`
    - Params: `{ conversationId: number, includeScenario?: boolean }` (defaults true server‑side)
    - Result: `ConversationSnapshot`

  - `getEventsPage`
    - Params: `{ conversationId: number, afterSeq?: number, limit?: number }`
    - Result: `{ events: UnifiedEvent[], nextAfterSeq?: number }`

  - `subscribe`
    - Params: `{ conversationId: number, includeGuidance?: boolean, filters?: { types?: Array<'message'|'trace'|'system'>, agents?: string[] }, sinceSeq?: number }`
    - Result: `{ subId: string }`
    - Behavior: Emits `'event'` and `'guidance'` notifications; if `sinceSeq` provided, replays backlog since that cursor (filtered). If `includeGuidance=true`, the server also emits a one‑shot initial guidance snapshot:
      - If there’s an open turn → `continue_turn` for the current owner.
      - Else if no messages but `startingAgentId` → `start_turn` to the starter.
      - Else if the last message closed a turn → `start_turn` to the next agent per policy.
      - Else (conversation completed) → no guidance.

  - `unsubscribe`
    - Params: `{ subId: string }`
    - Result: `{ ok: true }`

  - `subscribeConversations`
    - Params: none
    - Result: `{ subId: string }`
    - Behavior: Push notifications `{ method: 'conversation', params: { conversationId } }` when new conversations are created.

  - `sendMessage`
    - Params: `{ conversationId: number, agentId: string, messagePayload: MessagePayload, finality: 'none'|'turn'|'conversation', turn?: number }`
    - Result: `{ conversation: number, turn: number, event: number, seq: number }`

  - `sendTrace`
    - Params: `{ conversationId: number, agentId: string, tracePayload: TracePayload, turn?: number }`
    - Result: `{ conversation: number, turn: number, event: number, seq: number }`

  - `clearTurn`
    - Params: `{ conversationId: number, agentId: string }`
    - Result: `{ turn: number }`
    - Behavior: Appends an abort marker (idempotent) if this agent owns the open turn; returns the turn that should be used next.

  - `getEnsuredAgentsOnServer`
    - Params: `{ conversationId: number }`
    - Result: `{ ensured: Array<{ id: string; class?: string }> }`
    - Behavior: Returns the union of live server‑hosted agents and persisted ensures from the registry.

  - `ensureAgentsRunningOnServer`
    - Params: `{ conversationId: number, agentIds?: string[] }`
    - Result: `{ ensured: Array<{ id: string; class?: string }> }`
    - Behavior: Idempotently ensures agents are running for a conversation. If `agentIds` is omitted, ensures all agents from metadata; if provided, ensures only that subset (incremental).

  - `stopAgentsOnServer`
    - Params: `{ conversationId: number, agentIds?: string[] }`
    - Result: `{ ok: true }`
    - Behavior: Stops ensured agents. Note: current host implementation stops all agents for the conversation; subset stop is not yet supported server‑side.

- Notifications (push)
  - `event`: `UnifiedEvent`
  - `guidance`: `GuidanceEvent` (see shape below)
  - `conversation`: `{ conversationId: number }`

- Error mapping
  - JSON‑RPC errors use structured `{ error: { code, message, data? } }`.
  - Notable codes: `-32010` (turn conflicts), `-32011` (finalized), `-32012` (invalid turn), `-32013` (finality rules), `-32000` (generic), `404` (not found), plus JSON‑RPC standard `-32700` (parse error), `-32601` (method not found).

Types (key shapes)
- `MessagePayload` (see `src/types/event.types.ts`)
  - `{ text: string, attachments?: Array<{ id?, docId?, name, contentType, content?, summary? }>, outcome?, clientRequestId? }`
- `TracePayload` (discriminated union)
  - `{ type: 'thought'|'tool_call'|'tool_result'|'user_query'|'user_response'|'turn_aborted', ... }`
- `UnifiedEvent`
  - `{ conversation, turn, event, type: 'message'|'trace'|'system', payload, finality, ts, agentId, seq }`
- `GuidanceEvent`
  - `{ type: 'guidance', conversation, seq, nextAgentId, kind: 'start_turn'|'continue_turn', turn?: number, deadlineMs? }`

Guidance semantics
- Push:
  - On conversation creation with `startingAgentId`: emit `start_turn` for the starter.
  - On `message` with `finality='turn'`: emit `start_turn` for the next agent per policy.
- Pull (subscribe):
  - With `includeGuidance=true`, emit a one‑shot guidance snapshot as described above so clients can act immediately.
- Turn rules:
  - Traces can open and continue a turn.
  - Only messages can close a turn (`finality in {'turn','conversation'}`).
- `ConversationMeta` / `CreateConversationRequest`
  - `{ meta: { title?, description?, scenarioId?, agents: AgentMeta[], startingAgentId?, config?, custom?, metaVersion? } }`
- `ConversationSnapshot`
  - `{ conversation, status, metadata, events, lastClosedSeq, scenario?, runtimeMeta? }`

Internal/In‑Process Client APIs
These are TS utilities used by agents and CLIs to talk to the server (via WS) or embed the orchestrator directly (in‑process). They are not HTTP routes but are part of the supported client surface.

- `WsJsonRpcClient` (`src/agents/clients/ws.client.ts`)
  - Purpose: Minimal JSON‑RPC client for external agent executors.
  - Key methods:
    - `ensureSubscribed(conversationId)` → subscribes with guidance; stores `subId`.
    - `unsubscribe()`.
    - `getSnapshot(conversationId)` → `ConversationSnapshot` (includes scenario by default).
    - `waitForChange(conversationId, sinceSeq, timeoutMs)` → `{ timedOut, latestSeq }` (polling via subscription side‑effects).
    - `postMessage({ conversationId, agentId, text, finality, attachments?, clientRequestId?, turn? })` → append result.
    - `postTrace({ conversationId, agentId, payload, turn?, clientRequestId? })` → append result.
    - `close()`.

- `InProcessClient` (`src/agents/clients/inprocess.client.ts`)
  - Purpose: Same surface as above, but executes directly against `OrchestratorService` (no WS).
  - Methods: `getSnapshot`, `postMessage`, `postTrace`, `now`.

- Event Streams (`src/agents/clients/event-stream.ts`)
  - `WsEventStream`
    - Purpose: Async iterator over WS `'event'`/`'guidance'` notifications with automatic reconnect and heartbeats.
    - Ctor: `(wsUrl, { conversationId, includeGuidance?, reconnectDelayMs?, heartbeatIntervalMs?, filters?, sinceSeq? })`.
    - Methods: async iterator protocol; `close()`; optional `onStateChange` callback.
  - `InProcessEventStream`
    - Purpose: Async iterator wrapping `orchestrator.subscribe` in‑process.
    - Ctor: `(orchestrator, { conversationId, includeGuidance? })`.
  - `createEventStream(contextOrUrl, options)`
    - Purpose: Helper that returns the appropriate stream based on `string` WS URL or orchestrator instance.

- Backlog helper (`src/agents/clients/connect-with-backlog.ts`)
  - `connectWithBacklog(wsUrl, rpcClient, { conversationId, includeGuidance?, filters?, pageLimit? })`
    - Purpose: Race‑free pattern — fetch one page via `getEventsPage`, then subscribe from the last seen `seq`.
    - Returns: `{ backlog, stream, nextAfterSeq? }`.
  - `createSimpleRpcClient(wsUrl)` → tiny one‑shot RPC client implementing `{ call(method, params) }`.

- Agent Transports (`src/agents/runtime/*.transport.ts`)
  - `WsTransport`
    - Purpose: Implements `IAgentTransport` over WS JSON‑RPC for agent runtimes.
    - Methods: `getSnapshot`, `abortTurn`, `postMessage`, `postTrace`, `now`, `createEventStream(conversationId, includeGuidance)`.
  - `InProcessTransport`
    - Purpose: Implements `IAgentTransport` against an in‑memory `OrchestratorService`.
    - Same method surface as `WsTransport`.

- Browser Client (`src/client/*`)
  - `createEventStream(wsUrl, { conversationId?, includeGuidance? }, signal?)` → async iterable of events/guidance.
  - `sendMessage(wsUrl, { conversationId, agentId, text, finality, clientRequestId?, turn? })` → append result.
  - `getConversation(wsUrl, conversationId)` → snapshot.
  - `rpcCall(wsUrl, method, params?)` → generic one‑shot RPC.
  - `ensureAgentsRunningClient` and `autoResumeAgents` helpers exist in two variants:
    - `src/client/ensure-agents.ts`: simple browser‑centric version.
    - `src/agents/clients/ensure-client.ts`: richer version using `WsJsonRpcClient` and `WsEventStream` with filtering and persistence. Prefer this in agent UIs.

Message Shapes (selected)
- UnifiedEvent, MessagePayload, TracePayload, ConversationMeta, and ConversationSnapshot are defined under `src/types/*`. Use these types for strict TypeScript integration.

Notes and Caveats
- WebSocket path is `/api/ws`. Some older client helpers may derive `/ws`; prefer configuring `wsUrl` explicitly to `/api/ws`.
- Idempotency: `MessagePayload.clientRequestId` is forwarded for de‑duplication in stores. Duplicate semantics are enforced server‑side across turns.
- Scenario snapshots: WS `getConversation` includes scenario by default; `getConversationSnapshot` sets `includeScenario: true` explicitly in the server.
- MCP bridge encodes conversation meta in `config64`; see `conv-config.types.ts` for schema helpers.
