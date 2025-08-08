
IF you'r espliciting in possimbly undefined entries you can use the pattern

        ...(g.note !== undefined ? { note: g.note } : {}),

---

Design Documentation – Language-First Interoperability Reference Stack (v3)

Purpose
- This system is a compact, transparent reference implementation for testing language-based interoperability at a connectathon.
- It models workflows as conversations between agents, with a unified event log, real-time fanout, optional internal agents, and a WebSocket JSON-RPC interface for external agents.
- It emphasizes reproducibility, observability, and strict invariants that make interop testing dependable.

What this document covers
- Accurate description of the current codebase you provided (the older v2 README is not authoritative for this revision).
- Architecture, data model, core types, orchestrator behavior, APIs, and agent patterns (internal and external).
- Guidance and claim mechanics for coordinating turns among multiple agents.
- Scenario storage and hydration.
- LLM provider abstractions and configuration.
- Operational concerns and gaps versus the older README.

High-level architecture
- HTTP+WS server (Hono on Bun)
  - REST API for conversations, events, attachments, and scenarios
  - WebSocket JSON-RPC for event streaming and write operations
- Orchestrator service
  - Authoritative append-only event log and fanout
  - Scheduling policy to emit “guidance” events (transient) after turn finality
  - Turn-claim store to prevent duplicate work across agents
- Storage facade (SQLite via bun:sqlite)
  - Conversations, events, attachments, idempotency keys, turn claims, scenarios
- Agent runtime
  - Internal agents (run in-process) and event streams
  - External executors (event stream via WS, claim RPCs)
  - LLM-powered agents via provider manager (Google, OpenRouter, Mock)

Core concepts and types
- Event types (src/types/event.types.ts)
  - EventType: message | trace | system
  - Finality: none | turn | conversation
  - UnifiedEvent: normalized event row with turn/event indexing, seq, ts, agentId
  - MessagePayload
    - text
    - attachments (array)
      - name, contentType, content, summary, docId, id (reference)
    - outcome (status, reason, codes)
    - clientRequestId (for idempotency)
  - TracePayload
    - thought, tool_call, tool_result, user_query, user_response
  - SystemPayload
    - idle_timeout, note, turn_claimed, claim_expired, meta_created, meta_updated
- Conversation metadata (src/types/conversation.meta.ts)
  - ConversationMeta: title, description, scenarioId, agents[], config, custom
  - AgentMeta: id, kind (internal|external), role, displayName, avatarUrl, config
  - CreateConversationRequest: subset for creation
- Orchestrator types (src/types/orchestrator.types.ts)
  - ConversationSnapshot: events + metadata + status
  - HydratedConversationSnapshot: snapshot + scenario configuration
  - SubscribeFilter: conversation and optional types/agents
  - GuidanceEvent: transient advisory (not persisted)
- Scenario configuration (src/types/scenario-configuration.types.ts)
  - Comprehensive schema for scenario metadata, agents, stages, rules, knowledge, config

Persistence model (SQLite schema)
- conversations
  - conversation (PK), title, description, scenario_id, meta_json (JSON for agents/config/custom)
  - status: active | completed
  - created_at, updated_at (trigger keeps updated_at fresh)
  - Indices on status+created_at and scenario_id
- conversation_events
  - conversation, turn, event, type, payload (JSON), finality, ts, agent_id
  - seq is global autoincrement PK (total order)
  - Unique (conversation, turn, event)
  - Indices on (conversation, ts)
- attachments
  - id (att_<uuid>), conversation, turn, event, doc_id, name, content_type, content, summary, created_by_agent_id, created_at
- idempotency_keys
  - (conversation, agent_id, client_request_id) -> seq
- turn_claims
  - (conversation, guidance_seq) PK, agent_id, claimed_at, expires_at
  - Index on expires_at
- scenarios
  - id (scenarioId), name, config (ScenarioConfiguration as JSON), history (JSON), created_at, modified_at

Event invariants (enforced by EventStore)
- Only message events may set finality (turn or conversation). Trace and system must use finality=none.
- Only message events can start new turns (when input.turn is omitted).
- If a turn is finalized by a message with finality turn or conversation, no more trace/system events may be appended to that turn.
- If a conversation has a prior message with finality=conversation, no further events can be appended at all.
- Idempotency with clientRequestId (per conversation+agent): if a duplicate message/trace arrives with same clientRequestId, the previously written event is returned.
- Attachments are stored atomically; message payloads are rewritten to strip raw content and include references by id and optional docId/summary.

System events
- meta_created: emitted after conversation creation with metadata snapshot
- turn_claimed: advisory when an agent successfully claims a turn (via claimTurn)
- claim_expired: advisory when watchdog removes expired claims
- note and idle_timeout supported semantically, not actively emitted in v3 baseline code
- System events are advisory and cannot start new turns; they only append within an already open turn. If there is no open turn, they are skipped silently.

Guidance and claims
- Scheduling policy
  - SimpleAlternationPolicy (default):
    - Reacts only to message events that finalized a turn
    - Determines participants from conversation metadata.agents or infers from history
    - Picks the “other participant” to speak next
    - Emits a transient GuidanceEvent: nextAgentId and deadlineMs (default 30000)
  - ScenarioPolicy (available but not wired by default) uses ScenarioConfiguration to drive the same logic
- GuidanceEvent
  - type: 'guidance', conversation, seq (fractional: last seq + 0.1), nextAgentId, deadlineMs
  - Not persisted; delivered only to subscribers who opt-in (includeGuidance=true)
- Turn claims
  - Agents call claimTurn(conversationId, agentId, guidanceSeq)
  - SQL unique constraint (conversation, guidance_seq) guarantees only one winner
  - Same agent re-claim is treated as ok=true (idempotent), though claim method returns false; orchestrator normalizes to ok:true in that case
  - Expires at now + idleTurnMs (configurable, default 120s)
  - Watchdog runs every 5s:
    - Finds expired claims, deletes them, and tries to append claim_expired system events if an open turn exists

Orchestrator service (src/server/orchestrator/orchestrator.ts)
- appendEvent flow
  - Delegates to EventStore.appendEvent to enforce invariants and write
  - Publishes the last appended event via SubscriptionBus to all matching subscribers
  - Runs post-write orchestration (watch policy, emit guidance)
  - If message finality=conversation, ConversationStore.complete() marks conversation completed
- sendMessage helper
  - Allows starting a new turn (if turn omitted) or appending to an open turn
- sendTrace helper
  - Finds the last open turn; if none, throws an error unless a turn is provided
- Snapshots
  - getConversationSnapshot: events + status + metadata
  - getHydratedConversationSnapshot: snapshot + scenario config (if scenarioId present)
- Turn claims
  - Orchestrator.claimTurn writes to turn_claims with expiry; emits a system turn_claimed advisory if successful
- Claim expiration cleanup
  - After every turn-finalizing message, orchestrator deletes active claims for the conversation (cleanupClaims)

Subscription bus (src/server/orchestrator/subscriptions.ts)
- subscribe(filter, listener, includeGuidance=false) -> id
  - filter: conversation (required), optional types and agents filters (used by internal bus; WS server currently exposes only conversation+includeGuidance)
- publish(e: UnifiedEvent) fans out to matching subscribers
- publishGuidance(g: GuidanceEvent) only to subscribers that opted in (includeGuidance)
- unsubscribe(id)

WebSocket JSON-RPC API (src/server/ws/jsonrpc.server.ts)
- URL: /api/ws
- Connection lifecycle
  - On open, server sends a JSON-RPC notification: { jsonrpc: '2.0', method: 'welcome', params: { ok: true } }
- Methods implemented
  - subscribe { conversationId, includeGuidance? } -> { subId }
    - Starts receiving JSON-RPC notifications of:
      - { method: 'event', params: UnifiedEvent }
      - { method: 'guidance', params: GuidanceEvent } only if includeGuidance=true
  - unsubscribe { subId } -> { ok: true }
  - getConversation { conversationId } -> ConversationSnapshot
  - sendTrace { conversationId, agentId, tracePayload, currentTurn? } -> { ok: true } or JSON-RPC error
  - sendMessage { conversationId, agentId, messagePayload, finality, currentTurn? } -> { ok: true } or JSON-RPC error
  - claimTurn { conversationId, agentId, guidanceSeq } -> { ok: boolean, reason?: string }
- Notes
  - authenticate is defined in types but not implemented in the server
  - subscribe filters by types/agents are supported by the in-process bus but not exposed at the WS boundary in this revision
  - sendMessage/sendTrace responses are { ok: true } for simplicity; the external client samples tolerate this

REST API (src/server/routes/conversations.http.ts and scenarios.http.ts)
- GET /api/conversations?status=active|completed&scenarioId&limit&offset
  - Returns ConversationRow[] with denormalized metadata fields and metaJson
- POST /api/conversations
  - Body: CreateConversationRequest; if scenarioId provided, validates scenario exists and may default title from scenario metadata
  - Emits a meta_created system event within an open turn if possible; otherwise advisory only
  - Returns ConversationRow
- GET /api/conversations/:id
  - Optional query: includeEvents=true to return ConversationSnapshot
  - Optional query: includeMeta=true to return ConversationWithMeta (includes metadata)
  - Default: ConversationRow
- GET /api/conversations/:id/events
  - Returns UnifiedEvent[]
- GET /api/conversations/:id/attachments
  - Returns AttachmentRow[]
- GET /api/attachments/:id
  - Returns AttachmentRow
- GET /api/attachments/:id/content
  - Returns raw content with appropriate content-type
- Scenarios
  - GET /api/scenarios -> list ScenarioItem[]
  - GET /api/scenarios/:id -> ScenarioItem
  - POST /api/scenarios -> create ScenarioItem by config.metadata.id
  - PUT /api/scenarios/:id -> update name/config
  - DELETE /api/scenarios/:id

EventStore invariants and behavior (src/db/event.store.ts)
- New turn allocation: only by message with no turn specified (allocNextTurn)
- Event allocation: allocNextEvent per conversation+turn
- Turn closure: once a message with finality turn|conversation exists on a turn, the turn is closed
- Conversation closure: once any message has finality conversation, all further appends are rejected
- Finality vs type: trace/system must have finality none; message can use any finality
- Idempotency
  - If clientRequestId present on message/trace, the insert is checked against idempotency_keys
  - On duplicate, the existing AppendEventResult is returned
- Attachments
  - Message with attachments is inserted without attachments first
  - Each attachment is inserted into attachments table
  - Payload is rewritten to references (id, optional docId, summary). Raw content is not persisted in payload
- Conversation completion
  - If a message has finality conversation, conversations.status is updated to completed

Attachments behavior (src/db/attachment.store.ts)
- insertMany stores the items with assigned id att_<uuid> (unless provided)
- retrieval supports getById, listByConversation, getByDocId
- The event payload includes attachment refs only; content retrieval is via REST GET /api/attachments/:id/content

Turn claims behavior (src/db/turn-claim.store.ts)
- claim(conversation, guidanceSeq, agentId, expiresAt) returns true if inserted, false on unique constraint violation
- getClaim(conversation, guidanceSeq)
- deleteExpired() and getExpired() support watchdog
- getActiveClaimsForConversation(conversation) helps cleanup on turn completion
- deleteClaim(conversation, guidanceSeq) removes on successful completion

Scenarios storage (src/db/scenario.store.ts)
- insertScenario, findScenarioById, listScenarios, updateScenario, deleteScenario
- config stored as ScenarioConfiguration JSON; history field supports future UI builders

Agents and execution patterns
- Agent interface (src/agents/agent.types.ts)
  - handleTurn(ctx: AgentContext)
  - AgentContext: conversationId, agentId, deadlineMs, client (IAgentClient), logger
  - IAgentClient provides getSnapshot, postMessage, postTrace, now()
- Internal agents
  - InProcessClient calls orchestrator directly
  - InProcessEventStream subscribes to bus without WS
  - InternalTurnLoop
    - Consumes event stream with includeGuidance=true
    - On guidance targeting this agent, attempts to claimTurn via orchestrator (direct, not WS)
    - If ok, constructs context and calls agent.handleTurn
    - Stops on conversation finality
- External agents
  - WsEventStream
    - Connects to /api/ws; sends subscribe; receives event/guidance notifications
    - Heartbeat pings; auto-reconnect; auto-unsubscribe/close on conversation end
  - TurnLoopExecutor
    - Uses WsEventStream (includeGuidance=true)
    - On guidance for this agent, attempts claimTurn via ClaimClient (WS RPC)
    - Runs agent.handleTurn with ClaimClient implementing IAgentClient over JSON-RPC
    - Stops on conversation finality
  - ClaimClient JSON-RPC methods: claimTurn, sendMessage, getConversation, sendTrace
- Supplied agents
  - EchoAgent: simple progress + final message turn
  - AssistantAgent: wraps LLM provider; builds chat history and posts completion with finality turn
  - ScriptAgent: deterministic scripted actions (post/trace/sleep/assert)

LLM provider layer
- Types (src/types/llm.types.ts)
  - LLMMessage, LLMRequest, LLMResponse, LLMTool, abstract LLMProvider
  - Supported providers: google, openrouter, mock
- ProviderManager (src/llm/provider-manager.ts)
  - getProvider(config?): chooses provider by overrides or default from ConfigManager
  - Resolves API key from app config or override; throws for non-mock without key
  - getAvailableProviders(): metadata discovery
- Providers
  - GoogleLLMProvider (@google/genai)
    - Requires API key to call complete; converts messages to Google content format
    - Models: gemini-2.5-* with sensible default
  - OpenRouterLLMProvider (OpenAI client with OpenRouter baseURL + headers)
    - Requires API key; passes messages directly; supports temperature and maxTokens
  - MockLLMProvider
    - No API key required; returns echo-style response; useful for tests and demos

Server, configuration, and lifecycle
- App (src/server/app.ts)
  - Loads ConfigManager (env + overrides)
  - Constructs Storage (SQLite), ProviderManager, OrchestratorService
  - Shutdown closes orchestrator and DB
- ConfigManager (src/server/config.ts)
  - Validated via zod
  - dbPath, port, idleTurnMs, googleApiKey, openRouterApiKey, defaultLlmProvider, logLevel, nodeEnv
  - forTest() convenience (in-memory DB, test env)
- HTTP server entry (src/server/index.ts)
  - Creates singleton App
  - Mounts conversation routes, scenario routes, and WebSocket server
  - GET /health for readiness
  - Graceful SIGTERM shutdown
- Storage facade (src/server/orchestrator/storage.ts)
  - Creates EventStore, ConversationStore, AttachmentStore, IdempotencyStore, TurnClaimStore, ScenarioStore over one Database
  - Supports constructing from existing Database

Testing and demos
- Unit and integration tests cover
  - DB schema and bootstrap
  - Event invariants (turn/event allocation, finality enforcement, idempotency, attachments)
  - Conversation metadata and scenario indexing
  - Subscription filtering
  - Orchestrator fanout, guidance emission, convenience helpers
  - WS event stream client behavior (subscribe, heartbeats, reconnection, close on finality)
  - Provider manager and individual providers
- CLI demos (run with Bun)
  - src/cli/run-sim-inproc.ts: in-process agents with internal turn loop
  - src/cli/run-sim-ws-simple.ts: one external agent via WS
  - src/cli/run-sim-ws-new.ts: two external agents alternating via WS
  - src/cli/run-sim-metadata.ts: rich conversation metadata and external agent
  - src/cli/run-sim-hydrated.ts: scenario creation, conversation hydration, event append
- Example flow for an external agent (WS)
  1) Connect to ws://host/api/ws
  2) Send subscribe { conversationId, includeGuidance: true }
  3) Await 'guidance' notification with nextAgentId matching your agent
  4) Call claimTurn { conversationId, agentId, guidanceSeq }
  5) On success, send:
     - Optional traces via sendTrace (currentTurn optional if turn is open)
     - One or more sendMessage calls; finalize the turn with finality='turn', or end conversation with 'conversation'
  6) Repeat on next guidance. Stream ends when a message with finality='conversation' is observed.

Connectathon playbook
- Internal simulation
  - Create conversation via REST
  - Start one or more internal executors (InternalTurnLoop) bound to agent IDs present in metadata, or just use CLI demo
  - Kick off with a user message; observe guidance and responses
- External interop testing
  - Provide your agent as an external WS client
  - Implement guidance-consume, claim, trace, and message finalization loop
  - Ensure idempotency by setting clientRequestId on each write (especially with retries)
  - Use attachments to exchange structured artifacts; fetch content via REST when needed
- Observability
  - Subscribe to events for any conversation to build a live UI
  - Use GET /api/conversations/:id?includeEvents=true for full history
  - Attachments retrievable via REST endpoints

Operational notes
- Concurrency and durability
  - SQLite in WAL mode; transactions around event appends
  - Append-only event log with global seq ensures total order
- Time and clocks
  - Server timestamps via SQLite datetime('now')
  - Claim expirations compare to new Date().toISOString()
- Performance
  - Indices for common filters (status, scenario, conversation+ts)
  - Stream fanout is in-memory; scale horizontally by partitioning conversations or delegating pub/sub if needed
- Security
  - Authentication/authorization are not implemented in this revision; WS authenticate method exists in types but is not wired
  - For connectathon, deploy behind a trusted gateway or add auth at the reverse proxy
- Limits
  - Attachments are stored inline in SQLite attachments table; large blobs will increase DB size; consider external blob store for production

Extensibility
- Policies
  - Provide a custom SchedulePolicy via OrchestratorService constructor to change guidance behavior
  - ScenarioPolicy is included and demonstrates scenario-driven guidance
- Event types
  - Extend TracePayload variants for richer internal reasoning records
- Bridges
  - Add MCP or A2A bridges by mapping their semantics to this JSON-RPC and event model
- API
  - Expand WS server to implement filters on subscribe and authenticate; add more methods as needed
- LLM providers
  - Implement new LLMProvider subclasses and register in ProviderManager

Known differences from older README (v2)
- Management modes (internal vs external), start endpoints, and “automatic resurrection” are not present in this revision
- No user query API or human-in-the-loop flow in core types beyond trace payload variants
- WebSocket methods implemented are limited to subscribe, unsubscribe, getConversation, sendTrace, sendMessage, and claimTurn; authenticate exists in types only
- subscribe filters (types, agents) exist in the in-process bus but are not exposed as parameters in the WS server; WS subscribe accepts conversationId and includeGuidance only
- sendMessage/sendTrace WS replies return { ok: true } rather than event IDs; client utilities handle this
- Guidance is advisory and not persisted; system events also cannot start new turns and may be skipped if no turn is open

Practical examples

Minimal external agent loop (pseudocode):
- Connect WS to /api/ws
- Send: { id: '1', method: 'subscribe', params: { conversationId: 42, includeGuidance: true }, jsonrpc: '2.0' }
- On 'guidance' where nextAgentId matches you:
  - claimTurn: { id: '2', method: 'claimTurn', params: { conversationId: 42, agentId: 'agent-a', guidanceSeq: 100.1 }, jsonrpc: '2.0' }
  - If ok:
    - sendTrace (optional)
    - sendMessage finality='turn' (or 'conversation' to end)
    - Use clientRequestId for retries

Message with attachments:
- sendMessage payload: { text: 'Please see attached', attachments: [{ name, contentType, content, summary, docId }] }
- EventStore persists attachment rows and rewrites the payload to include { id, name, contentType, summary?, docId? }
- Retrieve content via GET /api/attachments/:id/content

Idempotency:
- Include clientRequestId in messagePayload or tracePayload to make writes safe to retry
- Duplicate writes return the existing event coordinates (on the in-process path) or ok:true (on WS path)

Running locally
- Use App in tests or demos with dbPath ':memory:'
- CLI demos demonstrate in-process and over-WS patterns; ws demos spin up an embedded server via Bun.serve
- For LLM-backed behavior, set GOOGLE_API_KEY or OPENROUTER_API_KEY in environment; default provider is mock in tests

Roadmap suggestions
- WS authenticate and authorization hooks; token-bound subscriptions
- Expose subscribe filters (types/agents) on WS
- Structured “user_query” control flow with REST endpoints for human response
- Persisted guidance (optional) or explicit guidance audit log
- Blob storage abstraction for attachments
- Multi-node scaling with external pub/sub for SubscriptionBus
- End-to-end resurrection of internal agents (the older README describes this; not implemented here)
- Better WS sendMessage/sendTrace responses with event coordinates

Summary
- This v3 codebase provides a clean, enforceable conversation/event substrate with guidance and claims to coordinate turns across agents.
- It is adequate for connectathon-style testing of language-based interoperability: precise invariants, clear APIs, idempotent writes, attachments, scenarios, and a deterministic scheduling policy.
- External teams can connect agents over WebSocket, follow guidance, claim turns, stream traces, and finalize messages, while observers watch the shared log in real time.
