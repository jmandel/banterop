# TODOs / Cleanup

## Cleanup
- Remove unused `accept` variable in `src/server/banterop.ts` (lint-only).
- Add explicit SSE headers on backchannel endpoints for proxy-friendliness:
  - `Cache-Control: no-cache, no-transform`
  - `Content-Type: text/event-stream; charset=utf-8`
  - `Connection: keep-alive`
  - `X-Accel-Buffering: no` (for Nginx)
- Factor the SSE keepalive timer (`event: 'ping'`) into a small helper to de-duplicate logic.

## Enhancements
- Control Plane: when a hard reset occurs, surface the new `aJoinUrl`/`bJoinUrl` links directly in the Control UI (not only in the responder banner).
- Production mode: add a simple `bun build` step and a static serving path so the app can run without Bun’s dev `routes`/HMR.
- Add a small smoke test or script to verify long-lived SSE connections (ensuring pings keep the connection open >60s).

## Defer / Review Later
- `src/shared/a2a-utils.ts`: currently unused; keep for now but remove if it remains unused after upcoming work.

