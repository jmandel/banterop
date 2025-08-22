# FlipProxy Demo (Bun + Hono + React)

A tiny mirror relay (**flip proxy**) that pairs two tabs and reflects messages between them using a minimal A2A-like API.  
Only the **responder tab** subscribes to a small backchannel (`server-events`) to learn about epoch switches; the **client tab** stays a pure A2A client and simply calls `message/stream` to start a new task when needed.

## Features
- JSON-RPC methods: `message/stream` (SSE), `tasks/resubscribe` (SSE), `tasks/get`, `tasks/cancel`.
- Finality extension via A2A part metadata: `metadata['urn:cc:a2a:v1'].finality = 'none' | 'turn' | 'conversation'`.
- Pair management endpoints:
  - `POST /api/pairs` → create a pair and returns join links.
  - `POST /api/pairs/:pairId/reset` with `{type:'soft'|'hard'}`.
- Responder-only backchannel: `GET /pairs/:pairId/server-events` (SSE).
- Front-end: React app (TSX) compiled by Bun; no bundler config required.

## Quick start

```bash
bun install
bun run dev
# open http://localhost:3000/ (Control Plane)
```

Use the Control Plane to create a pair; it shows persistent links you can open in new tabs:
- `participant/?pairId=...&role=a` → Client (initiator)
- `participant/?pairId=...&role=b` → Responder (server; listens to backchannel)

Send messages and choose finality (`turn` to pass the token; `conversation` to complete). Use Soft reset to start a new epoch; only the responder listens to the backchannel and re-subscribes automatically. No popups are used; links are displayed for manual opening.

## Project layout
```
src/
  server/flipproxy.ts   # Hono API + Bun.serve dev routes
  shared/               # shared types across server + frontend
    a2a-types.ts
    backchannel-types.ts
  frontend/
    control/index.html      # control plane; create pairs + SSE log
    participant/index.html  # participant UI shell; references ../app.tsx
    app.tsx                 # React entrypoint for participant UI
```

## Notes
- This is an in-memory demo (no DB). Add a best-effort tap to object storage or OTEL if you want observability.
- The proxy enforces a single **turn token** per pair. Messages with `finality:'turn'` flip the token; `'conversation'` completes both tasks.
- Hard reset creates a new pair and sends a `redirect` event on the backchannel to the responder. The client sees `canceled` on its A2A task and waits for a new send.
