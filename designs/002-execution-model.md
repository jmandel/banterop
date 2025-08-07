Design document: Executors, Agents, Orchestrator, and External Adapters (canonical, MCP-agnostic)

Purpose
- Define a clear, self-contained design for how agent code is executed (Executors), how it talks to the system (Agent Client), and how the server coordinates everything (Orchestrator).
- Make the internal protocol canonical. MCP/A2A are external projections only; internal components never depend on them.
- Support three participation modes with the same agent model:
  1) Internal agents (in-process)
  2) Direct external agents (JSON-RPC over WebSocket) with full parity
  3) Protocol-bridged participants (MCP, A2A) whose control loops live externally and do not execute our agent code

High-level goals
- One agent programming model. The same `Agent` class runs inside the server or outside it with identical behavior.
- Small, well-defined roles. No overloaded terms; each component has a crisp responsibility.
- Event log as source of truth. All correctness follows from append-only events and invariants, not from transient process state.
- Resilience. Any component may restart; participants resync via sequence cursors.

Core concepts and relationships

1) Orchestrator
- Definition: The server that owns conversations and the canonical internal protocol.
- Responsibilities:
  - Event log and invariants
    - Append events: `message`, `trace`, `system`.
    - Only `message` can set finality: `none`, `turn`, `conversation`.
    - No events after conversation finality=`conversation`.
    - No `trace`/`system` after a turn is closed.
    - Assign monotonically increasing `seq` for ordering and cursors.
  - Guidance and policy
    - Compute guidance: may_speak, wait, closed.
    - Apply scenario-driven policy when a turn closes to determine the next participant.
  - Fanout
    - Publish events to subscribers over WebSocket and SSE.
    - Provide long-poll/timeout primitives for simpler clients.
  - Internal execution
    - If the next participant is internal, invoke the Internal Executor to run that agent for one turn.
  - Recovery
    - On restart, recompute guidance and pending internal executions from the log.

2) Agent
- Definition: Stateless turn logic that decides whether to act when allowed to speak.
- Contract:
  - `handleTurn(ctx): Promise<TurnOutcome>`
  - While running, the agent may emit:
    - Messages with finality=`none` (progress or streaming)
    - Traces for observability
    - A final message with finality=`turn` or `conversation`
  - Return value `TurnOutcome` is advisory for the Executor (stop timers, metrics). Correctness is derived from logged finality, not the return value.
- Responsibilities:
  - Read recent context via the provided client.
  - Decide to post messages or yield.
  - Respect finality and turn semantics.

3) Agent Client (canonical internal protocol)
- Definition: The I/O adapter the Agent uses to talk to the Orchestrator. This is the canonical internal protocol. It does not depend on MCP/A2A.
- Implementations:
  - `InProcessClient`: direct calls to orchestrator services within the same process.
  - `WsJsonRpcClient`: JSON-RPC over WebSocket for parity when running the agent outside the server.
- Responsibilities:
  - Provide read APIs to fetch snapshots, tail events, and wait for change.
  - Provide write APIs to append messages and traces with idempotency.
  - Enforce or propagate invariants (finality rules).
  - Provide timing helpers (now, bounded waits).

4) Executor (Agent runner)
- Definition: A small controller that decides when to invoke an Agent for one attempt and supplies its context.
- Implementations:
  - InternalExecutor: lives in the orchestrator process; invoked by policy for internal agents.
  - ExternalExecutor: lives in an external process; used by partners to run the same agent code remotely with `WsJsonRpcClient`.
- Triggering modes:
  - Pull mode (default): Observe events/guidance and invoke `handleTurn` when it is that agent’s turn.
  - Optional “turn claim” push mode (advanced, direct external only): Orchestrator emits a `request_turn` notification to a selected ExternalExecutor instance with a bounded claim window to avoid duplicate replies in HA.
- Responsibilities:
  - Determine when to run the agent (based on guidance or request_turn).
  - Construct `AgentContext` with appropriate `IAgentClient`.
  - Enforce single invocation per conversation/agent under its scope.
  - Apply deadlines, capture traces/metrics, and handle retries/backoff.

5) External Adapter (protocol bridge)
- Definition: A separate process or library that speaks an external protocol and forwards content to/from the Orchestrator.
- Examples:
  - MCP Adapter: provides `wait_for_updates` and `post_message` to an IDE; maps to internal tail/wait and postMessage.
  - A2A Adapter: service-to-service; uses SSE to receive events and HTTP to post messages.
- Key property:
  - Adapters do not run our `Agent` or decide content. They reflect decisions made by an external user or peer.
  - They use the internal protocol to append messages and to read updates, but they are not Executors.

Data model and invariants

- Conversation
  - Identified by `conversationId`.
  - Append-only list of events with strictly increasing `seq`.
- Events
  - Message
    - Content, role/author, attachments.
    - Optional `finality`: `none` | `turn` | `conversation`.
  - Trace
    - Diagnostics/observability; cannot set finality.
  - System
    - Internal notes; cannot set finality.
- Invariants
  - Only messages can change finality.
  - No events after conversation finality=`conversation`.
  - No traces/system after a turn is closed.
  - Idempotent writes via `clientRequestId`.

Interfaces (canonical, internal protocol)

TypeScript-like sketches:

Agent
- interface Agent {
    handleTurn(ctx: AgentContext): Promise<TurnOutcome>;
  }

TurnOutcome
- type TurnOutcome = 'posted' | 'yield' | 'no_action' | 'complete';

AgentContext
- interface AgentContext {
    conversationId: string;
    agentId: string;
    deadlineMs: number;
    client: IAgentClient;
    logger: { debug(msg: string, meta?: any): void; info(...); warn(...); error(...); };

    // Convenience helpers over client
    getUpdates(sinceSeq?: number): Promise<{ messages: Message[]; guidance: Guidance; latestSeq: number; status: ConversationStatus }>;
    post(text: string, finality?: 'none' | 'turn' | 'conversation', attachments?: Attachment[]): Promise<{ seq: number }>;
    postTrace(trace: TracePayload): Promise<{ seq: number }>;
    waitForChange(sinceSeq: number, timeoutMs: number): Promise<{ latestSeq: number; timedOut: boolean }>;
  }

IAgentClient
- interface IAgentClient {
    // Read
    getSnapshot(conversationId: string): Promise<Snapshot>;
    tail(conversationId: string, sinceSeq: number, limit?: number): Promise<UnifiedEvent[]>;
    waitForChange(conversationId: string, sinceSeq: number, timeoutMs: number): Promise<{ latestSeq: number; timedOut: boolean }>;
    getUpdatesOrGuidance(conversationId: string, sinceSeq?: number, limit?: number, timeoutMs?: number): Promise<{ messages: Message[]; guidance: Guidance; latestSeq: number; status: ConversationStatus; timedOut: boolean }>;

    // Write
    postMessage(params: { conversationId: string; payload: MessagePayload; finality: 'none' | 'turn' | 'conversation'; turnHint?: TurnHint; clientRequestId?: string }): Promise<AppendResult>;
    postTrace(params: { conversationId: string; payload: TracePayload; turn?: TurnRef; clientRequestId?: string }): Promise<AppendResult>;

    // Meta
    now(): Date;
  }

InProcessClient
- Calls orchestrator services directly (method invocations).
- Shares the same types and guarantees as `WsJsonRpcClient`.

WsJsonRpcClient
- Speaks the same internal protocol semantics over WebSocket JSON-RPC:
  - Methods: `authenticate`, `getConversation`, `tail`, `waitForChange` (or long-poll emulation), `sendMessage`, `sendTrace`.
  - Notifications: `event` fanout; optional `request_turn`.

Executors

InternalExecutor
- Trigger:
  - Orchestrator policy callback when a turn finalizes and the next speaker is internal.
- Operation:
  - Enforce: one in-flight invocation per (conversationId, agentId).
  - Build `AgentContext` with `InProcessClient`.
  - Call `handleTurn(ctx)` with a deadline.
  - If agent emits progress (finality=`none`), allow a short grace window to finalize or end the attempt and rely on the next trigger.
- Failure/retry:
  - If the process crashes, on restart the orchestrator re-evaluates policy and re-triggers if still applicable.

ExternalExecutor (for direct external agents)
- Trigger modes:
  - Pull: subscribe/tail and compute guidance; invoke when it’s your turn.
  - Optional push claim: on `request_turn` notification, claim and run within deadline to avoid duplicate replies across replicas.
- Operation:
  - Enforce single invocation per (conversationId, agentId) within this process.
  - Build `AgentContext` with `WsJsonRpcClient`.
  - Invoke `handleTurn(ctx)` with deadline.
- Resilience:
  - On reconnect, resync via `sinceSeq`; agents are stateless and re-derive context from the log.

External Adapters (protocol bridges)

MCP Adapter
- Lives outside the server (e.g., IDE/plugin host).
- Provides MCP endpoints:
  - `wait_for_updates` implemented by repeatedly calling internal `tail`/`waitForChange` primitives and mapping to MCP wire shape.
  - `post_message` implemented by calling internal `postMessage`.
- Holds no agent logic. It transports upstream user decisions to the orchestrator and returns updates from the orchestrator to the user.

A2A Adapter
- Lives outside the server (service-to-service).
- Reads via SSE stream mapped to internal event fanout.
- Writes via HTTP endpoint that maps to internal `postMessage`.
- Long-running but can reconnect; maintains a `sinceSeq` cursor; no agent logic.

Scheduling and policy

- Scenario configuration
  - Participating identities (agentId, roles).
  - Rules for “who speaks next.”
  - Stop conditions (max exchanges, idle timeouts).
  - Preference for internal vs external execution for specific identities.
- Policy execution
  - After a message with finality=`turn`:
    - Evaluate rules; compute next participant.
    - If next is internal: invoke InternalExecutor for one attempt.
    - If next is external:
      - Do nothing special for adapters: they will observe guidance and speak when ready.
      - For direct external agents running our code, allow pull mode or optionally emit a `request_turn` to coordinate across replicas.

Control flows

1) Internal assistant + MCP user
- MCP user posts via adapter; adapter calls `postMessage(..., finality='turn')`.
- Orchestrator policy selects internal assistant.
- InternalExecutor runs assistant with `InProcessClient`.
- Assistant streams progress (finality=`none`) and finalizes (finality=`turn`).
- MCP adapter’s `wait_for_updates` picks up new events and returns guidance that the user may speak.

2) Direct external agent parity (WS JSON-RPC)
- A partner runs an ExternalExecutor hosting our assistant agent.
- User completes a turn; partner’s executor observes guidance (pull) or receives `request_turn` (push claim).
- ExternalExecutor builds context with `WsJsonRpcClient` and calls `handleTurn`.
- Agent replies and finalizes; orchestrator fans out events to all subscribers (WS/SSE/MCP adapter).

3) All-internal multi-agent
- Scenario alternates two internal agents.
- After each finalized message, policy selects the next; InternalExecutor invokes that agent.
- Process continues until stop conditions are met.

Operational concerns

- Concurrency and race avoidance
  - Orchestrator enforces append invariants globally.
  - Each Executor enforces single invocation per conversation/agent locally.
  - Optional push claim prevents multiple ExternalExecutor replicas from double-speaking.
- Back-pressure
  - Streams are best-effort; clients must resync using `sinceSeq` after disconnects.
- Idempotency
  - Writers use `clientRequestId` to deduplicate retries for `postMessage`/`postTrace`.
- Observability
  - Agents may `postTrace` key steps; the orchestrator can aggregate metrics (turn durations, message counts).
- Recovery
  - Everything re-derives from the log; cursors and guidance are recomputable.

Why this design is parsimonious and symmetric
- Single agent model and client interface; identical agent code runs internal or external.
- Executors are thin and symmetrical: construct context, run once, exit.
- External adapters are protocol conduits only; they do not pollute the internal model.
- The orchestrator remains the single source of truth with small, clear duties.

API surface (canonical internal protocol)

JSON-RPC over WebSocket (used by `WsJsonRpcClient` and general subscribers)
- Methods
  - `authenticate(token) -> { ok: boolean; agentId: string }`
  - `getConversation({ conversationId }) -> Snapshot`
  - `tail({ conversationId, sinceSeq, limit? }) -> { events: UnifiedEvent[]; latestSeq: number }`
  - `waitForChange({ conversationId, sinceSeq, timeoutMs }) -> { latestSeq: number; timedOut: boolean }`
  - `sendMessage({ conversationId, payload, finality, turnHint?, clientRequestId? }) -> AppendResult`
  - `sendTrace({ conversationId, payload, turn?, clientRequestId? }) -> AppendResult`
- Notifications
  - `event({ conversationId, event })`
  - Optional: `request_turn({ conversationId, agentId, claimId, deadlineMs, sinceSeq })` for push-claim coordination

HTTP/SSE (for adapters and simple clients)
- SSE: `/conversations/{id}/events?sinceSeq=...` -> server-sent events stream.
- Long-poll: `/conversations/{id}/wait?sinceSeq=...&timeoutMs=...` -> { latestSeq, timedOut } plus optional batch of events.
- REST write: `POST /conversations/{id}/messages` -> `AppendResult`, honoring `clientRequestId`.

Minimal implementation plan
- Define TypeScript interfaces for `Agent`, `AgentContext`, `IAgentClient`, and `Executor`.
- Implement `InProcessClient` using direct orchestrator service calls.
- Implement `WsJsonRpcClient` with the JSON-RPC methods listed above.
- Implement `InternalExecutor`:
  - Hook into “turn finalized” policy signal.
  - Enforce one in-flight invocation per conversation/agent.
  - Deadlines, logging, retries.
- Provide a sample `ExternalExecutor`:
  - Connect via WS, authenticate, subscribe, compute guidance, run agent on turns (pull mode).
  - Optionally handle `request_turn` if HA coordination is needed.
- Keep MCP and A2A strictly as external adapters:
  - MCP adapter implements MCP endpoints by translating to the internal protocol.
  - A2A adapter implements SSE/HTTP by translating to the internal protocol.
  - Neither is referenced by `InProcessClient`, `WsJsonRpcClient`, agents, or executors.
