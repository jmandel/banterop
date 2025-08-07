Language-First Interoperability: A Unified-Event Conversation Platform
A ground-up design for stateless, multi-agent conversational interoperability with append-only event logs, explicit finality, and transport-agnostic orchestration.

Part 1 — Problem Statement and Goals

Why a new model?
Healthcare interoperability increasingly involves autonomous or semi-autonomous agents acting on behalf of institutions (payers, providers, sponsors) to resolve complex workflows (prior authorization, referrals, clinical trial matching). Traditional API-first integrations struggle with:

Rigidity: APIs often assume fixed schemas and predefined workflows.
Fragmentation: Tool calls, messages, and system states live in different data and operational models.
Statefulness: Long-lived agents complicate fault tolerance, deployment, and scaling.
Opacity: It’s hard to inspect reasoning and reconstruct causal histories.
Language-first interoperability flips the paradigm: agents communicate through natural-language conversations augmented by tool calls. This design requires a runtime that:

Treats conversation as the primary substrate.
Records everything in a single, replayable, append-only log.
Makes agent processes ephemeral and stateless between turns.
Cleanly supports external participants using open transports (WebSocket, MCP, A2A).
Core goals

Single source of truth: One append-only event log per conversation that can fully reconstruct state.
Stateless agents: Internal agents spin up per turn, perform one unit of work, write events, exit.
Explicit finality: Use message events to close turns and conversations (no side-band end events).
Glass-box reasoning: Keep “trace” events alongside messages for deterministic audit.
Transport-agnostic: Orchestrator and clients communicate via a small stable interface.
Horizontal scalability: Shard by conversation; schedule agents as ephemeral workers.
Human-friendly: Short integer identifiers for conversation, turn, and event positions.
Non-goals

Replaying arbitrary sub-histories to mutate past results (immutability is a feature).
Coupling the system to a specific LLM or tool protocol.
Requiring external agents to be stateful (it should be optional).
Part 2 — Conceptual Model

Key concepts

Conversation: A logical room where agents exchange messages and traces to achieve goals for their principals.
Turn: A logical “unit of speaker output.” A turn can contain traces (thoughts, tool calls/results) and one or more message chunks, with the last message chunk ending the turn via finality.
Event: The atomic, append-only record. Everything is an event.
Event envelope

conversation: int // Autoincrement conversation id (tenant-scoped if multi-tenant)
turn: int // 1..n, scoped to conversation
event: int // 1..n, scoped to (conversation, turn)
type: "message" | "trace" | "system"
payload: JSON // Schema depends on type
finality: "none" | "turn" | "conversation"
ts: timestamp
agentId: string // Opaque agent identity, e.g., "patient-agent"
Rules:

Only type="message" can set finality to "turn" or "conversation".
Traces always have finality="none".
For any turn, all trace events must appear before the final message chunk for that turn.
After a “conversation” finality event, no further events are accepted.
Examples
(42,1,1) type=trace finality=none { type:"thought", content:"I’ll check policy" }
(42,1,2) type=trace finality=none { type:"tool_call", tool:"lookup_policy", args:{...} }
(42,1,3) type=trace finality=none { type:"tool_result", result:{...} }
(42,1,4) type=message finality=turn { text:"Here’s the policy summary…", attachments:[...] }
(42,2,1) type=message finality=conversation { text:"Approved. Closing case.", outcome:{status:"success"} }

Part 3 — Data Model and Storage

Database tables

conversation_events (append-only)
conversation INT NOT NULL
turn INT NOT NULL
event INT NOT NULL
type TEXT NOT NULL CHECK (type IN ('message','trace','system'))
payload JSON NOT NULL
finality TEXT NOT NULL CHECK (finality IN ('none','turn','conversation'))
ts TIMESTAMP NOT NULL
agent_id TEXT NOT NULL
PRIMARY KEY (conversation, turn, event)
INDEX idx_events_conversation_ts (conversation, ts)
Optional:

seq BIGINT PRIMARY KEY AUTOINCREMENT — a global total order for auditing/sharding.
tenant_id TEXT — for multi-tenant isolation; combined in PK or as partition key.
attachments (content-addressed or row-addressed)
id TEXT PRIMARY KEY // att_<uuid> or content hash
conversation INT NOT NULL
turn INT NOT NULL
event INT NOT NULL // points to the message event that references it
doc_id TEXT // logical docId referenced in payload
name TEXT NOT NULL
content_type TEXT NOT NULL
content TEXT NOT NULL
summary TEXT
created_by_agent_id TEXT NOT NULL
created_at TIMESTAMP NOT NULL
INDEX idx_attachments_conversation (conversation, created_at)
INDEX idx_attachments_doc (conversation, doc_id)
conversations (metadata and indexing)
conversation INT PRIMARY KEY // same as conversation id in events
created_at TIMESTAMP NOT NULL
title TEXT
description TEXT
status TEXT NOT NULL CHECK (status IN ('active','completed')) // derived from events but helps read
tenant_id TEXT
INDEX idx_conversations_tenant_status (tenant_id, status, created_at DESC)
Notes:

“status” is derived (last message finality == conversation -> completed). It can be denormalized for read performance.
All state is reconstructible by replaying conversation_events.
Attachment reference pattern

Message payload may include attachments: [{ id, docId, name, contentType, summary }]
The server persists attachment rows and includes references (ids) in the message payload. Alternatively, message payload can contain docId references and the server does the attachment creation atomically with the event write.
Part 4 — Orchestrator Responsibilities

Orchestrator invariants

Append-only writes: never mutate prior events.
Enforce finality:
Reject new events after a conversation-finalized message.
Reject traces/messages after a turn-finalized message (for that turn).
Single-writer per agent per conversation at a time (optional strictness):
Optional: disallow multiple concurrent turns by the same agent in a conversation.
Scheduling model

Internal agents (server-managed): orchestrator owns “who speaks next” for these only.
Upon receiving a message with finality="turn":
Determine next eligible internal agent(s) via policy (e.g., round-robin, scenario policy).
Spawn a stateless worker for that agent to produce its next turn (traces + final message).
External agents: orchestrator does not schedule/rspawn; they subscribe to events and respond at will (within constraints).
Orchestrator may emit advisory “system” events such as “next_candidate_agents”.
Turn lifecycle under unified events

An internal worker:
Reads the conversation by replay (or via “snapshot” read).
Emits trace events as it reasons and calls tools (addTrace).
Emits a final message event with finality="turn" (sendMessage).
Exits.
If the worker crashes mid-trace:
Events remain in the log; no turn finality message exists.
A watchdog can emit a system “idle_timeout” event and optionally close the turn by appending a message with finality="turn" authored by “system-orchestrator” (policy choice), or leave open for manual intervention.
Event write API (server-internal)

appendEvent(conversation, turn?, type, payload, finality, agentId):
Allocates turn if needed when writing a message for a new turn.
Allocates event id (1 + last).
Performs invariant checks for finality.
If finality='conversation', marks conversation status cached as completed.
If payload references attachments, atomically create attachment rows and return ids.
Read APIs (server-internal)

getConversationSnapshot(conversation, options):
Returns events ordered by (turn,event) with optional projections (last message per turn, attachments).
tailEvents(conversation, sinceSeq or since(ts)):
For streaming to clients/bridges.
Part 5 — Public APIs

REST (for reads and light writes)

GET /api/conversations?tenantId=&status=&limit=&offset=
Returns conversations with metadata.
GET /api/conversations/:conversationId?includeEvents=true&includeAttachments=true
Returns a snapshot: all events + attachment metadata.
GET /api/conversations/:conversationId/events?sinceEvent=… or sinceTs=…
Incremental event feed (HTTP chunked or pagination).
GET /api/attachments/:id
Metadata for attachment.
GET /api/attachments/:id/content
Content stream.
JSON-RPC over WebSocket (primary write path for agents and UIs)

authenticate({ token })
subscribe({ conversationId, filters? }) // push “event” notifications as events append
sendTrace({ conversationId, currentTurn, tracePayload }) -> { conversation, turn, event }
sendMessage({ conversationId, currentTurn?, messagePayload, finality }) -> { conversation, turn, event }
If no currentTurn is provided, this starts a new turn.
finality ∈ {'none','turn','conversation'}
getConversation({ conversationId, includeEvents?, includeAttachments? })
getAllConversations({ filters… })
Optional: registerWebhook({ conversationId, url, eventTypes })
Bridges (MCP, A2A)

MCP tools
begin_chat_thread() -> { conversationId }
send_message_to_chat_thread({ conversationId, message, attachments? }) -> { ack } // typically finality='turn'
wait_for_reply({ conversationId }) -> { reply or stillWorking status }
A2A:
Fully async; both sides can






Josh
continue, you got cut off in "Bridges (MCP, A2A) ..."






2 minutes ago
Favicon for openrouter
--
Bridges (MCP, A2A) — continued

MCP bridge

Contract

begin_chat_thread() → { conversationId }
send_message_to_chat_thread({ conversationId, message, attachments? }) → { ack, conversationId, turn }
Bridge maps this to a single message event with finality="turn" and optional trace events if the bridge wants to expose reasoning/tool activity on behalf of the external client.
wait_for_reply({ conversationId }) → { reply? , stillWorking: boolean, status? }
Bridge tails the event stream for the next counterparty message event following the client’s last turn. If none arrives within timeout, returns stillWorking: true and status (e.g., action counts, last action type).
Statelessness

The MCP server does not need a persistent in-memory agent. It:
Writes a message event when send_message_to_chat_thread is called.
Subscribes/long-polls the unified log for the next counterparty message.
If the server restarts, the MCP client can call wait_for_reply again; the bridge reconstructs from the log.
Attachments

The bridge accepts attachments as name/contentType/content strings and passes them to sendMessage, which atomically stores in attachments table and returns attachment ids. The message payload includes references to these ids.
A2A bridge

Contract

Asynchronous, bidirectional messaging between two servers (Agent-to-Agent).
Each side:
Subscribes to unified events for a conversation.
Can append trace and message events.
Uses an authentication and tenancy boundary to ensure isolation.
Delivery semantics

At-least-once notification via event subscriptions (WebSocket or webhook).
Idempotent writes supported via clientRequestId in message payload to prevent duplicate appends on retries.
Human-in-the-loop

Either side can emit a type:"trace" with { type:'user_query', ... } and later a { type:'user_response', ... } or simply model the HIL as a separate “human agent” emitting message events. UIs subscribe to the same unified log and can write the response payloads as events.
Part 6 — Internal Agents as Stateless Workers

Worker contract

Input

conversationId
full conversation snapshot (events + attachment metadata) or a streaming tail since last known event; the worker may request more via getConversation.
agent configuration (system prompt, tools) and scenario context (if applicable).
Behavior (one turn max)

Derive state (what happened last, what to do next) by folding events.
Produce:
zero or more sendTrace() events (thoughts/tool calls/results).
one sendMessage() with finality='turn' or, if policy dictates, finality='conversation'.
Exit.
Failure handling

If the worker crashes before finality, traces remain; orchestrator can retry or time out.
Watchdog policies:
“Turn timeout” → orchestrator writes a message with { text:"Timed out" } and finality='turn' authored by “system-orchestrator”.
“Conversation timeout” → similar with finality='conversation'.
Scheduling policy

The orchestrator implements a pluggable “next-speaker” policy for internal agents:
Default: after any message with finality='turn', schedule the other party if internal.
Scenario-driven: a policy function gets the full state (last events, scenario rules) and returns a candidate list or a single agent id.
If the next agent is external, orchestrator emits a system “next_candidate_agents” event for visibility but does not spawn workers.
Concurrency and guards

One open turn per agent per conversation: enforced by checking that the last event authored by that agent for the current turn had finality != 'none'.
Or stricter: zero concurrent open turns per conversation (strict alternation). This is a policy choice; the unified model supports both.
Part 7 — Client and Agent Interfaces (SDKs)

Agent client (TypeScript sketch)

Authentication

authenticate({ token })
Subscriptions

subscribe({ conversationId, filters? }, callback: (event) => void)
Writes

sendTrace({ conversationId, currentTurn, trace }) → { conversation, turn, event }
sendMessage({ conversationId, message, attachments?, finality }) → { conversation, turn, event }
If currentTurn not provided, this starts a new turn.
finality ∈ {'none','turn','conversation'}
Attachments are passed as payloads; server persists and returns ids, which will be included in the message payload.
Reads

getConversation({ conversationId, includeAttachments? })
tailEvents({ conversationId, sinceEvent? | sinceTs? }, onEvent)
Helpers

createWorkerContext(conversationSnapshot): builds a structured view (turns with last message, traces-by-turn, attachments map).
withTurn(async fn): utility that enforces the “traces then final message” pattern, guarding against misuse.
Payload schemas (SDK-level)

Trace payload

{ type: 'thought', content: string }
{ type: 'tool_call', name: string, args: any, toolCallId: string }
{ type: 'tool_result', toolCallId: string, result?: any, error?: string }
{ type: 'user_query', question: string, context?: any, clientRequestId?: string }
{ type: 'user_response', queryId: string, response: string }
Message payload

{ text: string, attachments?: Array<{ id?: string; name: string; contentType: string; content: string; summary?: string; docId?: string }>, outcome?: { status: 'success'|'failure'|'neutral', reason?: string, codes?: string[] }, clientRequestId?: string }
System payload

{ kind: 'idle_timeout' | 'note' | 'next_candidate_agents' | 'policy_hint', data?: any }
Error handling contract

All writes return an error if:
conversation is finalized.
the provided currentTurn conflicts with finality rules.
payload schema invalid.
Idempotency: if clientRequestId is provided, server may deduplicate identical retried writes and return the original {conversation, turn, event}.
Part 8 — Orchestrator Interfaces

Internal service interface

appendEvent(input): Promise<{ conversation, turn, event }>
Validates finality rules.
Allocates turn/event ids and writes atomically.
Persists attachments if present; injects their ids into payload (or stores references).
getConversationSnapshot(conversation, opts): Promise<ConversationSnapshot>
{ events: Event[], attachments: AttachmentMeta[], status }
streamEvents(conversation, sinceCursor, onEvent): unsubscribeFn
scheduleInternalNext(conversation): void
Applies policy to pick next internal agent and enqueues a worker job.
runWorker(conversation, agentId): Promise<void>
Executes the stateless worker for one turn; uses SDK to emit trace/message events.
Public transport endpoints

WebSocket JSON-RPC: authenticate, subscribe, sendTrace, sendMessage, getConversation, getAllConversations.
REST: read endpoints; optionally, POST write endpoints for simple integration (less real-time).
Part 9 — Security, Tenancy, and Governance

AuthZ model

Tokens scoped to (tenant, conversation, agentId).
Server validates:
Agent can write events tagged with its agentId only.
Readers need tenant rights to subscribe/list conversations.
PII/PHI handling

Payloads can contain PHI; apply:
Row-level encryption at rest by tenant.
Field-level redaction for logs/exports.
Access policies: only participants (or admins) can read a conversation’s events.
Multi-tenant isolation

Partition by tenant_id in conversations and events tables (or use separate DBs).
Hide raw conversation ids externally if needed; expose composite ids or aliases.
Auditing and compliance

Global seq for total ordering across conversations (optional).
Immutable append-only log simplifies audits.
Export APIs to deliver WORM-like archives.
Part 10 — Observability and Ops

Metrics

Events/sec by type and tenant.
Turn latency (first trace → final message).
Worker success/error rates and durations.
Backlog of “eligible internal turns” awaiting scheduling.
Tracing

Include clientRequestId and correlation ids for tool calls.
Log appendEvent decisions and rejections with reasons.
Alarms

Turn timeouts by policy thresholds.
Repeated worker crashes for same conversation.
High rate of write rejections (indicates misuse or attacks).
Part 11 — Implementation Notes and Patterns

Replaying efficiently

You can materialize “views”:
last_message_per_turn (conversation, turn, msg_event_ref)
conversation_status (derived)
attachments_index (conversation → by docId)
Cache scenario/agent configs by version key; workers fetch them cheaply.
Prompt building for LLM agents

Fold events into:
Messages from other agents: chronological display text with attachment summaries.
Own past turns: optionally include traces in scratchpad format for better grounding.
Windowing and summarization:
If the event log is long, keep summary events (type:"system", kind:"summary") that roll up earlier turns to keep prompts bounded.
Idempotency details

On appendEvent, if clientRequestId is present, maintain a small dedupe table keyed (conversation, agentId, clientRequestId) → (turn,event). Expire rows after N days.
Attachments strategy

Two-phase:
Client includes attachment payloads in sendMessage; server creates attachments and returns their ids; the message payload stored in events references those ids and docIds.
Alternatively, pre-upload attachments via REST and reference them in message payload by id; the server just links them to the (conversation,turn,event) upon append.
Part 12 — Example Flows

Prior auth approval flow (internal + external)

External “patient-agent” sends:
message(finality='turn', text:"I need PA for knee MRI", attachments:[order.pdf])
Orchestrator schedules internal “insurer” worker:
traces(thought/tool_calls/results)
message(finality='turn', text:"Please confirm PT notes and facility NPI", attachments:[policy excerpt])
Patient agent replies with PT docs:
message(finality='turn', attachments:[pt-notes.md])
Insurer worker evaluates:
traces(tool_result showing eligibility)
message(finality='conversation', text:"Approved", outcome:{status:'success'})
Timeout case

After step 2, if no response:
system(kind:'idle_timeout') then optionally message(finality='turn', text:"Closing pending due to inactivity") by orchestrator, or leave to human follow-up policy.
Part 13 — Summary

This unified-event, append-only design:

Replaces fragmented state with a single replayable log.
Makes internal agents stateless and ephemeral, improving reliability and scalability.
Keeps external participation simple via event subscriptions and idempotent writes.
Uses explicit finality to eliminate racey “close” events and simplify client logic.
Preserves “glass box” transparency by interleaving traces and messages.
With a small, stable set of APIs, strong invariants, and careful payload schemas, the platform becomes simpler to operate, easier to scale, and more auditable—while remaining flexible enough to support rich, language-first interoperability across organizations and agents.







Josh
OK now let's create a from-scratch dev plan for the project. Similar to th eorigina project we'll use bun ts, hono, a shared codebase with types and impls that can run in serve ror i nbrowesr. Le'ts create a list of individual files to produce and what they'll do;






33 seconds ago
Favicon for openrouter
--
Great. Here’s a pragmatic from-scratch dev plan aligned to Bun + TypeScript + Hono, with a shared monorepo structure. It focuses on the unified-event model, stateless workers, and transport-agnostic clients. For each file or directory, I list purpose and key exports.

Top-level

package.json
Workspaces, scripts (dev, build, test, lint), module resolution.
bunfig.toml
Bun runtime config.
tsconfig.json
Project references, path aliases ($lib, $types, $server, $client).
.env.example
Config placeholders (DB path, provider keys).
README.md
Project overview and quick start.
src/

types/

index.ts
Re-exports all domain types for convenience.
event.types.ts
UnifiedEvent envelope:
conversation: number, turn: number, event: number, type: 'message'|'trace'|'system', payload: any, finality: 'none'|'turn'|'conversation', ts: Date, agentId: string
TracePayload, MessagePayload, SystemPayload
AttachmentRef, Outcome
api.types.ts
REST/WS RPC contracts:
AuthenticateRequest/Response
SubscribeRequest/Notification
SendTraceRequest/Response
SendMessageRequest/Response
GetConversationRequest/Response
ListConversationsRequest/Response
TailEventsRequest/Response
orchestrator.types.ts
Internal service contracts:
AppendEventInput/Result
ConversationSnapshot
SchedulePolicy, WorkerInput
scenario.types.ts
Scenario config and agent definitions (system prompts, tools).
llm.types.ts
LLMProvider, LLMRequest/Response.
lib/

utils/
id-alloc.ts
DB-safe allocation helpers for turn and event ids; optional global seq.
payload-validators.ts
Zod schemas for MessagePayload, TracePayload, SystemPayload.
folding.ts
Helpers to fold event streams into:
turns[], lastMessagePerTurn, attachmentsByDocId, etc.
attachment-utils.ts
Normalize incoming attachment payloads, generate docId fallbacks, content safeties.
idempotency.ts
ClientRequestId dedup logic (hash keys; TTL).
security/
auth.ts
Token parsing and validation, scopes (tenant, conversation, agentId).
rbac.ts
Simple authorization utilities.
db/

schema.sql
conversation_events, attachments, conversations, optional idempotency.
sqlite.ts
Bun SQLite wrapper; connection pool; migrations.
event.store.ts
EventStore class:
appendEvent(input: AppendEventInput): Promise<AppendEventResult>
getEvents(conversation: number): Promise<UnifiedEvent[]>
tail(conversation: number, sinceEvent?: number): AsyncIterable<UnifiedEvent>
Finality checks; indices; transactions.
attachment.store.ts
CRUD for attachments (row-addressed).
conversation.store.ts
Create/list conversations, status denormalization, tenant filters.
idempotency.store.ts
Insert/check by (tenant, conversation, agentId, clientRequestId).
server/

index.ts
Boot Hono server; mount routes under /api; initialize providers; start Bun server; WebSocket handler setup.
orchestrator/
orchestrator.ts
Core service:
appendEvent, getConversationSnapshot, streamEvents
Finality enforcement
Advisory system events (next_candidate_agents, idle_timeout)
scheduleInternalNext(conversation)
runWorker(conversation, agentId)
policy.ts
Pluggable SchedulePolicy (round-robin, scenario-based, strict alternation).
worker-runner.ts
Executes internal workers (stateless):
Fetch snapshot, construct prompt, send trace(s), send final message.
subscriptions.ts
Fanout to WebSocket clients; manages topic subscriptions and filters.
routes/
conversations.http.ts
GET /conversations
GET /conversations/:id (snapshot, includeAttachments)
GET /conversations/:id/events (tail, pagination)
attachments.http.ts
GET /attachments/:id
GET /attachments/:id/content
diag.http.ts
Health, metrics stubs (events/sec, backlog, worker stats).
ws/
jsonrpc.server.ts
Hono + WebSocket JSON-RPC:
authenticate
subscribe
sendTrace
sendMessage
getConversation
getAllConversations
Notification: event with unified envelope.
bridge/
mcp.server.ts
MCP tool handlers that map to sendMessage and log tailing.
a2a.server.ts
A2A async handler: auth, event proxying, idempotent writes.
bridge.diag.ts
Tools list, context introspection.
client/

index.ts
Factory: createInProcessClient(orchestrator), createWebSocketClient(url).
orchestrator-client.ts
Interface:
connect, authenticate
subscribe(conversationId, filters?)
sendTrace, sendMessage
getConversation, getAllConversations
impl/
in-process.client.ts
Direct calls to orchestrator service; emits event locally.
websocket.client.ts
JSON-RPC wrapper; reconnect, resubscribe; synthetic “rehydrated” via snapshot fetch on reconnect.
sdk/
agent-helpers.ts
withTurn helper to enforce trace-before-final-message; auto-start new turn if currentTurn absent.
folding.ts
Browser-safe versions of fold helpers (no DB access).
schemas.ts
Re-export zod schemas to validate client payloads before send.
agents/

base.agent.ts
Stateless “one-turn” runner contract:
run(input: WorkerInput, client: OrchestratorClient): Promise<void>
Provides sendTrace, sendMessage helpers; no persistent fields across runs.
scenario-driven.agent.ts
Implements:
Prompt construction from snapshot (events → conversation history; include past traces for own turns).
Tool synthesis callouts via ToolOracle.
Emits traces and final message.
tool-oracle/
oracle.service.ts
Uses LLMProvider to synthesize tool results based on scenario omniscience; same reification rules as discussed.
example/
static-replay.agent.ts
Simple scripted agent turn for testing.
pass-through.agent.ts
Echo agent to verify bus behavior.
llm/

provider-manager.ts
Initialize providers (Gemini/OpenRouter) from env; default selection; model-to-provider routing.
providers/
google.provider.ts
openrouter.provider.ts
mock.provider.ts
Shared: LLMProvider impl with debug logging.
frontend/

apps/
dashboard/
React app: conversation list, creation form (title/tenant).
inspector/
Event log viewer:
Left: events stream
Center: message bubbles rendered by turn; interleaved traces
Right: payload inspector (trace detail, attachments)
bridge-console/
MCP/A2A demo tools to send/await messages.
shared/
api.ts
Fetch wrappers for REST; WebSocket hook for event stream.
tests/

unit/






