# A2A v0.3.0 Compatibility Report — Banterop Demo

This document evaluates the Banterop demo (Bun + Hono + React) against the Agent2Agent (A2A) Protocol Specification v0.3.0 and provides concrete recommendations to reach baseline compliance for the JSON‑RPC transport and SSE streaming.


## Summary
- Overall: Not compliant yet. The implementation is A2A‑like but misses required JSON‑RPC response envelopes, a valid Agent Card, and spec‑correct `message/send` and `tasks/cancel` behaviors.
- Target method coverage (this demo): `message/send`, `message/stream`, `tasks/get`, `tasks/resubscribe`, `tasks/cancel`.
- Path to MVP compliance (JSON‑RPC + SSE only):
  1) Wrap all responses (including SSE frames) in JSON‑RPC response objects with `jsonrpc:"2.0"` and the original request `id`.
  2) Implement spec‑correct `message/send` and `tasks/cancel` return values (return a Task/Message, not `{ok:true}`) and use JSON‑RPC error objects.
  3) Add missing `DataPart` and enforce `FilePart` exclusivity (`bytes` XOR `uri`).
  4) Ensure streaming status events include `final: true` on the last event; close SSE afterwards.
  5) Publish an Agent Card at a stable URL and declare `preferredTransport: "JSONRPC"`, `capabilities.streaming: true`.


## Scope Reviewed
- Transport: JSON‑RPC over HTTP, streaming via SSE.
- Endpoints: `POST /api/bridge/:pairId/a2a` (JSON‑RPC), `GET /pairs/:pairId/server-events` (custom backchannel, out of A2A scope), control‑plane HTML.
- Core methods implemented: `message/stream` (SSE), `tasks/resubscribe` (SSE), `tasks/get`, `tasks/cancel`, `message/send` (non‑conformant result).
- Data types: Message, Part (text/file only), Task, streaming status events (no artifacts streaming yet).


## Findings and Required Changes

### 1) JSON‑RPC Envelope (blocking)
- Current behavior:
  - Non‑stream responses sometimes return plain JSON (e.g., `{ result: ... }` or `{ ok: true }`) with HTTP status codes signaling errors.
  - SSE frames send `data: {"result": ...}` objects without `jsonrpc` or `id`.
- Spec requirements:
  - Every successful response must be a JSON‑RPC response: `{"jsonrpc":"2.0","id":<same-id>,"result":...}`.
  - Every error must be a JSON‑RPC error response: `{"jsonrpc":"2.0","id":<same-id|null>,"error":{ code, message, data? }}`.
  - For SSE, each `data:` frame must contain a full JSON‑RPC Response object (with `jsonrpc` and `id`).
- Recommendation:
  - Parse `id` from the incoming request and propagate it into all responses/frames for that request.
  - Keep HTTP status 200 and use JSON‑RPC error payloads for protocol errors.

Example JSON‑RPC success envelope (non‑stream):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "kind": "task", "id": "...", "contextId": "...", "status": { "state": "submitted" } }
}
```

Example JSON‑RPC error envelope:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32001, "message": "Task not found" }
}
```

Example SSE frame payload (each `data:` line):

```
data: {"jsonrpc":"2.0","id":1,"result":{"kind":"status-update","taskId":"...","contextId":"...","status":{"state":"working"},"final":false}}
```


### 2) Core RPC Methods (blocking)
- `message/send`:
  - Current: returns `{ ok: true }` and relies on side‑effects.
  - Required: Return a `Task` (or a `Message`) as JSON‑RPC `result`. If the target task is terminal or invalid, return JSON‑RPC error (`-32001` TaskNotFoundError, or `-32002` if restarting/continuing is disallowed in your model).
- `message/stream` (SSE):
  - Good: Starts a stream, sends an initial snapshot, then updates.
  - Fix: Wrap every frame in JSON‑RPC envelopes with the original `id`; include `final: true` on the last `TaskStatusUpdateEvent`, then close the stream.
- `tasks/get`:
  - Current: Returns `{ result: ... }` without JSON‑RPC envelope.
  - Fix: Return JSON‑RPC success envelope, accept optional `historyLength` and slice history if provided.
- `tasks/cancel`:
  - Current: Returns `{ ok: true }` or HTTP error.
  - Required: Return the final `Task` state as `result` or JSON‑RPC error (`-32001` if not found, `-32002` if cannot cancel).
- `tasks/resubscribe` (SSE):
  - Fix: Same envelope rules as `message/stream`.

See “Method Coverage & Contracts” below for exact request/response interfaces.


### 3) Data Model Gaps (important)
- `Part` union is missing `DataPart`.
- `FilePart` must enforce mutual exclusivity of `bytes` vs `uri`.
- `TaskState` should include the full enum; current code omits `rejected`, `auth-required`, `unknown` (you may map unused states to `unknown`).
- `TaskStatusUpdateEvent.final` should be present and accurate on terminal transitions.


### 4) Error Handling (important)
- Replace ad‑hoc HTTP 4xx with JSON‑RPC `error` bodies using standard and A2A‑specific codes:
  - `-32700` JSON parse error
  - `-32600` Invalid Request
  - `-32601` Method not found
  - `-32602` Invalid params
  - `-32603` Internal error
  - A2A: `-32001 Task not found`, `-32002 Task cannot be canceled`, `-32004 Unsupported operation`, etc.


### 5) Agent Card (important)
- Currently missing. Spec requires an `AgentCard` describing the endpoint URL and transports.
- Recommendation:
  - Serve at `/.well-known/agent-card.json`.
  - Use a stable JSON‑RPC URL (e.g., `/a2a/v1`). Today `:pairId` is in the path; prefer moving pair binding into `message.contextId` (already used in your objects), not the URL. If you keep pair‑scoped URLs for the demo, still publish a stable card and add explicit instructions to acquire a pair and pass its `contextId` in the first message.

Minimal Agent Card example for this demo:

```json
{
  "protocolVersion": "0.3.0",
  "name": "Banterop Bridge Agent",
  "description": "Pairs two participants and mirrors messages using JSON-RPC and SSE.",
  "url": "https://localhost:3000/a2a/v1",
  "preferredTransport": "JSONRPC",
  "additionalInterfaces": [
    { "url": "https://localhost:3000/a2a/v1", "transport": "JSONRPC" }
  ],
  "version": "0.1.0",
  "capabilities": { "streaming": true },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    {
      "id": "flip-proxy",
      "name": "Turn-based Mirror",
      "description": "Mirrors messages between paired participants with turn control.",
      "tags": ["relay", "chat", "proxy"]
    }
  ]
}
```


### 6) Streaming & SSE headers (nice to have)
- Add proxy‑friendly headers on SSE routes (`message/stream`, `tasks/resubscribe`, backchannel):
  - `Cache-Control: no-cache, no-transform`
  - `Content-Type: text/event-stream; charset=utf-8`
  - `Connection: keep-alive`
  - `X-Accel-Buffering: no` (nginx)
- Keep `ping` events to avoid idle timeouts (already implemented).


## Acceptance Checklist (MVP JSON‑RPC + SSE)
- JSON‑RPC envelopes:
  - All non‑stream responses wrap `result`/`error` with `jsonrpc:"2.0"` and the original `id`.
  - All SSE frames carry JSON‑RPC envelopes with the same `id` as the initiating request.
- Core methods:
  - `message/send` returns `Task|Message` result; respects terminal task rules; uses JSON‑RPC errors.
  - `tasks/get` accepts `historyLength` and slices history when provided.
  - `tasks/cancel` returns final `Task` or JSON‑RPC error.
  - `message/stream`/`tasks/resubscribe` stream JSON‑RPC frames; terminal event includes `final: true`.
- Data model:
  - `DataPart` supported; `FilePart` exclusivity enforced.
  - `TaskState` enum extended; `TaskStatus.timestamp` set where available.
- Agent Card:
  - Served at `/.well-known/agent-card.json` and declares `preferredTransport: JSONRPC` with a stable URL.


## TypeScript Reference (spec‑aligned subset)
The following TS definitions align with the provided schema subset and cover the necessary surface for this demo to be compliant for JSON‑RPC + SSE.

```ts
// ===== JSON-RPC base =====
export type JSONRPCId = string | number | null;

export interface JSONRPCMessage {
  jsonrpc: '2.0';
}

export interface JSONRPCRequest<P = any> extends JSONRPCMessage {
  id: JSONRPCId; // present for requests that expect a response/stream
  method: string;
  params?: P;
}

export interface JSONRPCSuccessResponse<R = any> extends JSONRPCMessage {
  id: JSONRPCId; // same as request id
  result: R;
}

export interface JSONRPCError {
  code: number; // includes JSON-RPC and A2A-specific codes
  message: string;
  data?: any;
}

export interface JSONRPCErrorResponse extends JSONRPCMessage {
  id: JSONRPCId; // null if request id could not be read
  error: JSONRPCError;
}

// Common helpers for streaming frames
export type JSONRPCResponse<R = any> = JSONRPCSuccessResponse<R> | JSONRPCErrorResponse;

// ===== Core data types =====
export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'auth-required'
  | 'unknown';

export interface TextPart {
  kind: 'text';
  text: string;
  metadata?: Record<string, any>;
}

export interface FileWithBytes {
  bytes: string; // base64
  name?: string;
  mimeType?: string;
}

export interface FileWithUri {
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface FilePart {
  kind: 'file';
  file: FileWithBytes | FileWithUri; // mutually exclusive by construction
  metadata?: Record<string, any>;
}

export interface DataPart {
  kind: 'data';
  data: Record<string, any>;
  metadata?: Record<string, any>;
}

export type Part = TextPart | FilePart | DataPart;

export interface Message {
  kind: 'message';
  role: 'user' | 'agent';
  parts: Part[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, any>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp?: string; // ISO 8601
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, any>;
  extensions?: string[];
}

export interface Task {
  kind: 'task';
  id: string;
  contextId: string;
  status: TaskStatus;
  history?: Message[];
  artifacts?: Artifact[];
  metadata?: Record<string, any>;
}

export interface TaskStatusUpdateEvent {
  kind: 'status-update';
  taskId: string;
  contextId: string;
  status: TaskStatus;
  final: boolean; // required in spec when streaming
  metadata?: Record<string, any>;
}

export interface TaskArtifactUpdateEvent {
  kind: 'artifact-update';
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, any>;
}

// ===== Requests & Responses =====
export interface MessageSendConfiguration {
  acceptedOutputModes?: string[];
  historyLength?: number;
  pushNotificationConfig?: PushNotificationConfig;
  blocking?: boolean;
}

export interface MessageSendParams {
  message: Message;
  configuration?: MessageSendConfiguration;
  metadata?: Record<string, any>;
}

export type SendMessageRequest = JSONRPCRequest<MessageSendParams> & {
  method: 'message/send';
};

export type SendStreamingMessageRequest = JSONRPCRequest<MessageSendParams> & {
  method: 'message/stream';
};

export interface TaskIdParams { id: string; metadata?: Record<string, any>; }
export interface TaskQueryParams extends TaskIdParams { historyLength?: number; }

export type GetTaskRequest = JSONRPCRequest<TaskQueryParams> & { method: 'tasks/get' };
export type CancelTaskRequest = JSONRPCRequest<TaskIdParams> & { method: 'tasks/cancel' };
export type TaskResubscriptionRequest = JSONRPCRequest<TaskIdParams> & { method: 'tasks/resubscribe' };

export type SendMessageSuccessResponse = JSONRPCSuccessResponse<Task | Message>;
export type GetTaskSuccessResponse = JSONRPCSuccessResponse<Task>;
export type CancelTaskSuccessResponse = JSONRPCSuccessResponse<Task>;
export type SendStreamingMessageSuccessResponse = JSONRPCSuccessResponse<
  Task | Message | TaskStatusUpdateEvent | TaskArtifactUpdateEvent
>;

// ===== Push notifications (optional for this demo) =====
export interface PushNotificationAuthenticationInfo {
  schemes: string[];
  credentials?: string;
}

export interface PushNotificationConfig {
  id?: string;
  url: string;
  token?: string;
  authentication?: PushNotificationAuthenticationInfo;
}

// ===== Error codes (subset) =====
export type A2AErrorCode =
  | -32700 // JSON parse error
  | -32600 // Invalid Request
  | -32601 // Method not found
  | -32602 // Invalid params
  | -32603 // Internal error
  | -32001 // Task not found
  | -32002 // Task cannot be canceled
  | -32003 // Push notifications not supported
  | -32004 // Unsupported operation
  | -32005 // Incompatible content types
  | -32006 // Invalid agent response
  | -32007; // Authenticated Extended Card not configured

export interface A2AError extends JSONRPCError { code: A2AErrorCode }

// ===== Agent Card (minimal) =====
export type TransportProtocol = 'JSONRPC' | 'GRPC' | 'HTTP+JSON';

export interface AgentInterface { url: string; transport: TransportProtocol | string; }

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  extensions?: Array<{ uri: string; description?: string; required?: boolean; params?: Record<string, any> }>;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  security?: Array<Record<string, string[]>>;
}

export interface AgentCard {
  protocolVersion: string; // default "0.3.0"
  name: string;
  description: string;
  url: string;
  preferredTransport?: TransportProtocol | string; // default JSONRPC
  additionalInterfaces?: AgentInterface[];
  iconUrl?: string;
  provider?: { organization: string; url: string };
  version: string;
  documentationUrl?: string;
  capabilities: AgentCapabilities;
  securitySchemes?: Record<string, any>;
  security?: Array<Record<string, string[]>>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  supportsAuthenticatedExtendedCard?: boolean;
  signatures?: Array<{ protected: string; signature: string; header?: Record<string, any> }>;
}
```


## Implementation Guidance (concrete next steps)

1) Add JSON‑RPC envelopes
- On request parse: `const { id, method, params } = body`.
- For non‑stream: return `JSON.stringify({ jsonrpc: '2.0', id, result })` with HTTP 200.
- For errors: return `JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data? } })` with HTTP 200.
- For SSE: create `const write = (payload) => stream.writeSSE({ data: JSON.stringify({ jsonrpc: '2.0', id, result: payload }) })`.

2) Fix `message/send`
- For a new task: allocate ids, return `Task` snapshot (status `submitted` or `working`).
- For existing task: validate terminal state; on invalid, return `-32001` or `-32002`.
- Respect `configuration.historyLength` by trimming returned history if provided.

3) Fix `tasks/cancel`
- If not found: `-32001`.
- If non‑cancelable: `-32002`.
- On success: set status `canceled` and return full `Task` snapshot in `result`.

4) Fix `tasks/get`
- Accept `historyLength` and slice `Task.history` if set.
- Return JSON‑RPC success envelope.

5) Streaming events
- On terminal transitions (`completed`, `canceled`, `failed`, `rejected`): emit a `TaskStatusUpdateEvent` with `final: true` then close the SSE stream.

6) Data parts
- Add `DataPart` and enforce `FilePart` mutual exclusivity at validation time (reject mixed `bytes`+`uri` with `-32602`).

7) Agent Card
- Serve `/.well-known/agent-card.json` with a stable JSON‑RPC URL (e.g., `/a2a/v1`).
- Continue to store/demo `pairId` in `Task.contextId` and derive internal pairing from the first `message/stream` or `message/send` of an epoch.

8) SSE headers
- Add `Cache-Control`, `Connection`, and `X-Accel-Buffering` headers on all SSE routes for proxy‑friendliness.


## Method Coverage & Contracts (canonical)
This demo should support exactly the methods below. The payload and response shapes are defined once in the TypeScript section above; we reference those interface names here to keep this report DRY.

- message/send
  - Request: `SendMessageRequest` (`params: MessageSendParams`)
  - Success (HTTP 200): `SendMessageSuccessResponse` with `result: Task | Message`
  - Errors: `JSONRPCErrorResponse` (`A2AErrorCode` as appropriate, e.g., `-32001`, `-32602`)
  - Notes: For a new conversation, create a Task and return its snapshot; for ongoing, append and return the current snapshot. Respect `configuration.historyLength`.

- message/stream (SSE)
  - Request: `SendStreamingMessageRequest` (`params: MessageSendParams`)
  - Stream frames: `SendStreamingMessageSuccessResponse` (each SSE `data:` is a JSON‑RPC response) whose `result` is `Task | Message | TaskStatusUpdateEvent | TaskArtifactUpdateEvent`
  - Terminal frame: `TaskStatusUpdateEvent` with `final: true`, then close SSE
  - Errors: Stream may begin with a `JSONRPCErrorResponse` frame

- tasks/get
  - Request: `GetTaskRequest` (`params: TaskQueryParams`)
  - Success: `GetTaskSuccessResponse` with `result: Task` (apply `historyLength` if provided)
  - Errors: `JSONRPCErrorResponse` (`-32001` for missing task, etc.)

- tasks/resubscribe (SSE)
  - Request: `TaskResubscriptionRequest` (`params: TaskIdParams`)
  - Stream frames: same as `message/stream` (`SendStreamingMessageSuccessResponse` frames)
  - Semantics: Resume streaming updates for an existing task; implementation may not backfill missed events
  - Errors: `JSONRPCErrorResponse` frames (e.g., `-32001` if task not found)

- tasks/cancel
  - Request: `CancelTaskRequest` (`params: TaskIdParams`)
  - Success: `CancelTaskSuccessResponse` with `result: Task` (status `canceled`)
  - Errors: `JSONRPCErrorResponse` (`-32001` if not found, `-32002` if cannot cancel)

### Implementation Notes: History and Current Message
- Task.history SHOULD exclude the most recent message to avoid duplication. The latest message SHOULD appear in `Task.status.message` alongside the current `Task.status.state`.
- When honoring `historyLength`, apply it after excluding the current message. Example: if there are 12 total messages and the most recent is placed in `status.message`, then `historyLength: 5` returns the 5 messages immediately preceding the current one.
- Recommended ordering for `Task.history`: oldest → newest (chronological). Clients can render `Task.status.message` as the tail message.
- For streaming (`message/stream`, `tasks/resubscribe`):
  - The initial Task snapshot frame MAY include `status.message` set to the last processed message, with that message omitted from `history`.
  - Subsequent `status-update` frames SHOULD set `status.message` to the event’s message (if any) and MUST NOT inject that same message into `history` within that frame.

Example (non‑stream response body):

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "result": {
    "kind": "task",
    "id": "t-123",
    "contextId": "c-abc",
    "status": {
      "state": "working",
      "message": {
        "kind": "message",
        "role": "user",
        "messageId": "m-12",
        "parts": [{ "kind": "text", "text": "latest input" }],
        "taskId": "t-123",
        "contextId": "c-abc"
      }
    },
    "history": [
      { "kind": "message", "role": "agent", "messageId": "m-11", "parts": [{"kind":"text","text":"previous"}] },
      { "kind": "message", "role": "user",  "messageId": "m-10", "parts": [{"kind":"text","text":"older"}] }
    ]
  }
}
```

## Notes & Deferred Items
- Push notifications (`tasks/pushNotificationConfig/*`) are optional; safe to defer.
- gRPC and REST transports are optional; current focus is JSON‑RPC.
- Authentication is optional; if later added, declare in `AgentCard.securitySchemes/security` and enforce at HTTP layer.
