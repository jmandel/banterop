# FlipProxy Demo (Bun + Hono + React)

A tiny mirror relay (**flip proxy**) that pairs two tabs and reflects messages between them using a minimal A2A-like API. Only the responder listens to a small backchannel; the initiator is a pure A2A Client. An optional MCP-compatible HTTP bridge is available alongside the A2A endpoint for initiator-side integrations.

## Current Features
- JSON-RPC: `message/stream` (SSE), `tasks/resubscribe` (SSE), `tasks/get`, `tasks/cancel`.
- Finality hint (turn semantics):
  - Sender sets `message.metadata['https://chitchat.fhir.me/a2a-ext'].finality` to `none|turn|conversation`.
  - Bridge updates task status and echoes the hint in streaming frames.
- Pair management:
  - `POST /api/pairs` (optional `{ metadata?: object }`) → creates a pair and returns structured endpoints and join links.
  - `POST /pairs/:pairId/reset` (hard reset only) → cancels current tasks, bumps epoch; next initiator send starts a fresh epoch for the same pair.
- Backchannel (responder only): `GET /pairs/:pairId/server-events` (SSE).
- Control-plane event log (live only): `GET /pairs/:pairId/events.log?since=<seq>` (SSE)
  - Streams concise events; no historical replay across restarts.
- Persistence (SQLite):
  - Pairs + tasks and full message histories are stored in SQLite (`messages` normalizes payload via JSON checks; uniqueness on `$.messageId`).
  - On startup, the server seeds the SSE ring from DB with `epoch-begin`, historical `message` events, and a derived `state`.

## Quick start

```bash
bun install
bun run dev
# open http://localhost:3000/ (Control Plane)
```

Use the Control Plane to create a pair; it shows links you can open in new tabs:
- `/client/?card=<AgentCard URL>` → Client (initiator). Back-compat: `/client/?a2a=<A2A URL>`.
- `/rooms/<PAIR_ID>` → Room backend (responder)

Send messages and choose finality (`turn` to pass the token; `conversation` to complete). After a hard reset, the next initiator send starts a new epoch. No popups are used; links are displayed for manual opening.

## Rooms (optional)
Rooms provide a stable workspace per `roomId` (alias of `pairId`), with exactly one active backend (a `/rooms/:roomId` tab) at a time.

- Open `/rooms/:roomId` to acquire the backend lease for the room; a second tab becomes an observer (banner explains how to take over).
- Header includes: “Open client” (launches `/client/?a2a=…`), copy Agent Card URL, copy MCP URL.
- Agent Card: `GET /rooms/:roomId/agent-card.json` (spec-like). The default includes:
  - `url`: `/api/rooms/:roomId/a2a` (JSONRPC alias of `/api/bridge/:roomId/a2a`).
  - `preferredTransport`: `JSONRPC` and `additionalInterfaces` repeating the same URL for clarity.
  - `capabilities.extensions[0]` with `uri: https://chitchat.fhir.me/a2a-ext` and `params: { a2a, mcp, tasks }`.
  - Provider defaults can be customized (see AGENT_CARD_TEMPLATE below).
- Feature flag (conceptual): when the backend isn’t open, ingress returns an in-band guidance message and marks the task failed; the message includes a full room URL for easy clicking.

Template-driven card overrides:
- Env `AGENT_CARD_TEMPLATE` may contain JSON used as a base (deep-merged with defaults, then with `pairs.metadata.agentCard`).
- Template supports placeholders: `{{roomId}}`, `{{BASE_URL}}`, `{{origin}}`.

## Control Plane
- Header: Create Pair, Hard reset, persistent join links when `#pair=<id>` is in the URL.
- Events section:
  - Status dot (idle/connecting/connected/error).
  - Since field resubscribes on blur (no dedicated reconnect button).
  - Buttons: Copy / Clear / Download.
  - Pretty JSON + Wrap toggles for raw inspection.
- Canonical compact rendering (no local timestamps):
  - `[pair-created] epoch=1`
  - `[epoch-begin] epoch=2`
  - `[reset-start] reason=hard 1→2`, `[reset-complete] epoch=2`
  - `[backchannel] subscribe epoch=1 task=resp:... turn=initiator`
  - `[state] initiator=input-required responder=working`
  - Note: This reference implementation does not emit separate `[message]` events. The latest message content is available within the `[state]` event’s embedded task `status.message`.
- Legend: “?” button opens a sheet describing event types.

## Client app (A2A)
- URL params: `a2a=<JSON-RPC endpoint>`, optional `transport=mcp&mcp=<MCP endpoint>`.
- UX:
  - Enter to send, tab order (input → finality → send), autofocus.
  - Finality: none | turn | conversation.
  - Send gating: send when `input-required` or no task yet; after cancel, shows “Send on new task”.
  - Cancel task (non-terminal states): calls `tasks/cancel`.
- Clear task (terminal states): clears local history and taskId to start fresh.

### URL Hash Schema (Readable JSON)
- Purpose: Share most client settings via human-readable JSON in the URL hash.
- Accepted formats: Raw JSON or percent‑encoded JSON in the hash (e.g., `#%7B...%7D`).
- Transport inference: `transport` is omitted. The app infers it from URLs:
  - If `agentCardUrl` is present → A2A
  - Else if `mcpUrl` is present → MCP
- Top-level fields:
  - `agentCardUrl`: string (A2A only)
  - `mcpUrl`: string (MCP only)
  - `llm`: `{ provider: "server" | "client-openai", model: string, baseUrl?: string }`
    - `apiKey` is intentionally excluded from the hash. Keys live only in `sessionStorage`.
  - `planner`: `{ id: "off" | "llm-drafter" | "scenario-v0.3" | "simple-demo", mode: "approve" | "auto" }`
  - `planners`: `{ [activeId]: { seed: object } }`  // current planner’s seed only
  - `rev`: number (monotonic; stale‑update protection)

Examples
```
# {"agentCardUrl":"https://…/agent-card.json","llm":{"provider":"server","model":"openai/gpt-oss-120b:nitro"},"planner":{"id":"llm-drafter","mode":"approve"}}

# {"mcpUrl":"https://…/mcp.json","llm":{"provider":"client-openai","baseUrl":"https://openrouter.ai/api/v1","model":"openai/gpt-4o"},"planner":{"id":"scenario-v0.3","mode":"auto"},"planners":{"scenario-v0.3":{"seed":{"scenarioUrl":"https://…/scenario.json"}}}}
```

Behavior
- On load, the app hydrates session defaults from the readable JSON hash before endpoint resolution.
- API keys are never read from the hash; any existing key in `sessionStorage` is preserved.
- When the store updates, the app writes a fresh JSON hash reflecting:
  - `agentCardUrl` or `mcpUrl` (not both),
  - `llm` provider, model, and `baseUrl` (for `client-openai` only),
  - `planner` id/mode,
  - `planners` seed for the active planner,
  - `rev` incremented to avoid stale overwrites.

## Persistence
- DB: `FLIPPROXY_DB` (default `:memory:`) — SQLite via Bun.
- Schema: `pairs`, `tasks`, and `messages(pair_id,epoch,author,json)` with JSON checks and unique index on `$.messageId`.
- Ordering: FIFO via rowid; optional stronger ordering can add a surrogate primary key.
- On startup, current epochs seed the SSE ring: `epoch-begin`, replay `message` events, then a derived `state`.

## API Summary
- `POST /api/pairs` (optional `{ metadata?: object }`) →
  - `{ pairId, endpoints: { a2a, mcp, agentCard }, links: { initiator: { joinClient, joinMcp }, responder: { openRoom } } }`
- `GET /api/pairs/:pairId/metadata` → `{ metadata }`
- `POST /pairs/:pairId/reset` (hard only) → `{ ok, epoch }`
- `GET /pairs/:pairId/server-events` (SSE; responder backchannel)
- `GET /pairs/:pairId/events.log?since=<seq>` (SSE; concise live events)
- Also supports `?backlogOnly=1` for a one-shot backlog response (used in tests)
- `POST /api/bridge/:pairId/a2a` JSON-RPC (alias: `/api/rooms/:pairId/a2a`):
  - `message/stream` (SSE), `message/send`, `tasks/get`, `tasks/resubscribe`, `tasks/cancel`.

### MCP Bridge (initiator-side)
- `POST /api/bridge/:pairId/mcp`
  - Same base as A2A (relative to initiator API base: `/api/bridge/:pairId/…`).
  - Accepts MCP Streamable HTTP requests and returns JSON responses for tool invocations.
  - Tools exposed:
    - `begin_chat_thread()` → `{ conversationId }` for the current epoch’s initiator task.
    - `send_message_to_chat_thread({ conversationId, message, attachments? })` → `{ guidance, status: "working" }`.
    - `check_replies({ conversationId, waitMs=10000 })` → `{ messages, guidance, status, conversation_ended }`.

Example (tool invocation via MCP HTTP transport payloads):

```bash
# Begin thread
curl -sS -X POST \
  -H 'content-type: application/json' \
  localhost:3000/api/bridge/<PAIR_ID>/mcp \
  -d '{
    "method": "tools/call",
    "params": { "name": "begin_chat_thread", "arguments": {} }
  }'

# Send message
curl -sS -X POST \
  -H 'content-type: application/json' \
  localhost:3000/api/bridge/<PAIR_ID>/mcp \
  -d '{
    "method": "tools/call",
    "params": { "name": "send_message_to_chat_thread", "arguments": { "conversationId": "init:<PAIR_ID>#<EPOCH>", "message": "Hello", "attachments": [] } }
  }'

# Check replies (long-poll 10s)
curl -sS -X POST \
  -H 'content-type: application/json' \
  localhost:3000/api/bridge/<PAIR_ID>/mcp \
  -d '{
    "method": "tools/call",
    "params": { "name": "check_replies", "arguments": { "conversationId": "init:<PAIR_ID>#<EPOCH>", "waitMs": 10000 } }
  }'
```

## Project layout
```
src/
  server/flipproxy.ts   # Hono API + Bun.serve dev routes + bun-storage persistence
  server/bridge/mcp-on-flipproxy.ts  # MCP bridge mounted at /api/bridge/:pairId/mcp
  shared/               # shared types across server + frontend
    a2a-types.ts
    backchannel-types.ts
  frontend/
    control/index.html      # Control Plane; create pairs + live event log
    control/app.tsx         # Control Plane UI logic
    client/index.html       # Client UI shell
    client/client.tsx       # React entrypoint for Client (A2A)
```

## Notes & Limitations
- Event log is live-only; the server keeps only an in-memory buffer (default 1000) for the current process. It is cleared on hard reset and not persisted across restarts.
- Pair meta + full task histories are persisted; restarts do not lose chats.
- Finality semantics: `turn` flips who is `input-required`; `conversation` completes both tasks; `none` keeps sender `input-required` and receiver `working`.
 - File parts: reference implementation only supports inline `bytes` (base64). URIs are not supported for attachments.
 - Security: pairs are not authenticated; anyone with a `pairId` could access backchannel/logs if reachable. Use for demos only.

## Testing
- `bun test --bail` to fail fast on first error.
- `npm run test:timeout` (uses a 5s overall timeout by default; override with `TEST_TIMEOUT=<seconds>`).
- Includes persistence, Rooms, and SSE tests under `tests/`.
