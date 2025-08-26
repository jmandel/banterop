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
- Persistence (bun-storage / SQLite):
  - Meta-only: pair meta + both tasks with full message histories are persisted; no event-log persistence.
  - JIT hydration: pairs are loaded from storage on demand (server-events, events.log, A2A) so the app continues after restart.
  - TTL eviction: idle pairs are evicted from memory and storage by a watchdog.

## Quick start

```bash
bun install
bun run dev
# open http://localhost:3000/ (Control Plane)
```

Use the Control Plane to create a pair; it shows links you can open in new tabs:
- `participant/?role=initiator&a2a=<encoded A2A URL>` → Initiator
- `participant/?role=responder&a2a=<encoded A2A URL>&tasks=<encoded backchannel URL>` → Responder (listens to backchannel)

Send messages and choose finality (`turn` to pass the token; `conversation` to complete). After a hard reset, the next initiator send starts a new epoch. No popups are used; links are displayed for manual opening.

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

## Participant app (A2A Client)
- URL params: `role=initiator|responder`, `a2a=<JSON-RPC endpoint>`, optional `tasks=<backchannel SSE>` (responder).
- UX:
  - Enter to send, tab order (input → finality → send), autofocus.
  - Finality: none | turn | conversation.
  - Send gating: send when `input-required` or (initiator) no task yet; after cancel, initiator sees “Send on new task”.
  - Cancel task (non-terminal states): calls `tasks/cancel`.
  - Clear task (terminal states): clears local history and taskId to start fresh.

## Persistence (bun-storage)
- DB: `FLIPPROXY_DB` (default `:memory:`).
- Stored under `pair:meta:<id>`:
  - id, epoch, turn, startingTurn, `eventSeq` (monotonic), `lastActivityTs`.
  - `metadata` (opaque JSON from pair creation).
  - tasks: initiator/responder with full `history` + `status`.
- Index: `pair:index` → array of pairIds.
- JIT hydration: when a pair is referenced and not in memory, meta is loaded from storage to rebuild live state (tasks + histories).
- No event replay: events.log/server-events stream live events only (no historical replay across restarts).
  - Persisted meta stores task `status` as a string (A2AStatus). Runtime snapshots and events embed `{ state, message? }` objects. This is intentional.

### TTL eviction
- Memory TTL (`PAIR_TTL_MEMORY_MS`, default 30m): evict idle pairs from memory (no active SSE or A2A streams).
- Storage TTL (`PAIR_TTL_STORAGE_MS`, default 48h): delete stale `pair:meta:<id>` and remove id from `pair:index`.
- Watchdog runs every 60s.

Note: tests run against an in-memory database by default and do not write `.sqlite` files. To opt-in to disk persistence tests locally, run with `FLIPPROXY_TEST_PERSISTENCE=1 bun test`.

## API Summary
- `POST /api/pairs` (optional `{ metadata?: object }`) →
  - `{ pairId, endpoints: { a2a, mcp, a2aAgentCard }, links: { initiator: { joinA2a, joinMcp }, responder: { joinA2a } } }`
- `GET /api/pairs/:pairId/metadata` → `{ metadata }`
- `POST /pairs/:pairId/reset` (hard only) → `{ ok, epoch }`
- `GET /pairs/:pairId/server-events` (SSE; responder backchannel)
- `GET /pairs/:pairId/events.log?since=<seq>` (SSE; concise live events)
- `POST /api/bridge/:pairId/a2a` JSON-RPC:
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
    participant/index.html  # Participant UI shell; references ../app.tsx
    app.tsx                 # React entrypoint for Participant (A2A Client)
```

## Notes & Limitations
- Event log is live-only; the server keeps only an in-memory buffer (default 1000) for the current process. It is cleared on hard reset and not persisted across restarts.
- Pair meta + full task histories are persisted; restarts do not lose chats.
- Finality semantics: `turn` flips who is `input-required`; `conversation` completes both tasks; `none` keeps sender `input-required` and receiver `working`.
 - File parts: reference implementation only supports inline `bytes` (base64). URIs are not supported for attachments.
 - Security: pairs are not authenticated; anyone with a `pairId` could access backchannel/logs if reachable. Use for demos only.

## Testing
- bun test
- Includes persistence and hydration tests under `tests/`.
