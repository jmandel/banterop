**Turn Management: Abort Markers, No Preconditions**

**Goals**
- Keep agents thinking only in turns.
- Make restarts trivial: abort, then continue.
- Keep server simple: enforce “one open turn at a time.”
- Avoid CAS/sequence logic entirely.

**Non-Goals**
- Perfect concurrency control for simultaneous new-turn opens.
- Server-side coalescing or rewriting history.
- Changing guidance rules.

**Event Model**
- Abort marker is an agent-authored trace:
  - Type: `trace`
  - Agent: aborting agent (not system)
  - Turn: current open turn
  - Finality: `none`
  - Payload: `{ type: 'turn_aborted', abortedBy: string, timestamp: string, reas
on?: string }`
- System events remain on turn 0; unchanged.
- Guidance still emits only on `message` with `finality='turn'|'conversation'`.

**Orchestrator Write Semantics**
- `abortTurn(conversationId: number, agentId: string): { turn: number }`
  - If there is an open turn and the last event in that turn is by `agentId`:
    - If the last event in that open turn is already an abort marker: do not wri
te; return that turn.
    - Else append the abort trace to that same turn; return that turn.
  - Else (closed turn or last author differs): do not write; return `{ turn: las
tTurn + 1 }`.

- `sendMessage(conversationId, agentId, payload, finality, turn?)`
  - Determine head: `head = getHead(conversationId)` with `head.hasOpenTurn`, `h
ead.lastTurn`.
  - If `turn` is provided:
    - If `head.hasOpenTurn` and `turn !== head.lastTurn`: reject with “Turn alre
ady open (expected turn X).”
    - If `!head.hasOpenTurn` and `turn !== head.lastTurn + 1`: reject with “Inva
lid turn number (next is Y).”
    - Else append to `turn`.
  - If `turn` is omitted:
    - If `head.hasOpenTurn`: append to `head.lastTurn` (continue open turn).
    - Else: start a new turn (the store allocates `lastTurn + 1`).
  - Attachments, idempotency, and guidance behavior remain as-is.

- `sendTrace(conversationId, agentId, payload, turn?)`
  - Same turn resolution rules as `sendMessage`.

- Enforced invariant
  - “Nobody can start a new turn while one is open”:
    - With explicit `turn`: we reject any attempt to set `turn = lastTurn + 1` w
hen `hasOpenTurn=true`.
    - With omitted `turn`: we always continue the open turn; we do not open a ne
w one.

**API Changes**

- Types
  - Add to `TracePayload`:
    - `| { type: 'turn_aborted'; abortedBy: string; timestamp: string; reason?: 
string }`
  - Remove preconditions from client/server types:
    - Drop `precondition` from `SendMessageRequest`, `SendTraceRequest`, transpo
rts, and agent base classes.
  - Keep `turn?: number` as an optional override for advanced clients.

- WS JSON-RPC
  - New method: `abortTurn`
    - Request: `{ conversationId: number; agentId: string }`
    - Response: `{ turn: number }`
  - `sendMessage`/`sendTrace` no longer accept `precondition`.
  - Errors:
    - Trying to open a new turn while one is open → code `-32010`, message “Turn
 already open (expected turn X).”
    - Invalid turn number (wrong explicit `turn`) → code `-32012`, message “Inva
lid turn (next is Y).”

- Transports (in-process + WS)
  - Add `abortTurn(conversationId, agentId)`.
  - `postMessage`/`postTrace` accept `turn?: number` only (no precondition).

**Client Coalescing (UI Helper)**
- Per-turn presentation:
  - For each turn N, find the last `trace` with `payload.type === 'turn_aborted'
`.
  - If found at index i, present events from i (including the abort marker) to t
he end of turn N; hide earlier events.
  - Ignore turn 0 in per-turn coalescing.
- Keeps the log raw while giving a clean “restart” narrative.

**Agent Usage Pattern**
- On startup or when scheduled:
  - `const { turn } = await transport.abortTurn(convoId, agentId)`
  - Continue work:
    - `await transport.postMessage({ conversationId, agentId, text: "...", final
ity: 'none' })`
    - `await transport.postMessage({ conversationId, agentId, text: "Done", fina
lity: 'turn' })`
- Notes:
  - No preconditions required.
  - Omit `turn` in normal usage; orchestrator will continue the open turn or ope
n a new one if none is open.
  - Only set `turn` explicitly if you need hard control; server will validate an
d reject illegal opens.

**Edge Cases**
- Turn closed when aborting: returns next turn; no write.
- Abort by wrong agent: returns next turn; no write.
- Multiple aborts: idempotent if trailing marker already present; otherwise allo
wed but coalescing uses the last marker.
- Attachments: unaffected.

**Concurrency Policy (KISS)**
- Accepted: If orchestration misfires and multiple agents attempt to write, they
 may write into the same open turn; new turn opens are blocked while a turn is o
pen.
- No CAS/sequence checks or `expectTurn` logic.

**Testing**
- Abort behavior:
  - Writes agent-authored abort marker in an open agent-owned turn; idempotent o
n repeated calls.
  - Returns next turn with no write for closed/wrong-agent scenarios.
- Turn enforcement:
  - With open turn, `sendMessage/Trace(turn = lastTurn + 1)` → error “Turn alrea
dy open”.
  - With no open turn, `sendMessage/Trace(turn !== lastTurn + 1)` → error “Inval
id turn”.
  - Omitted `turn`: continues open turn or opens new if none is open.
- WS:
  - `abortTurn` RPC produces a trace event; subscribers receive it.
  - Error codes/messages align with above.
- Coalescing:
  - Hides pre-abort content; includes last abort and subsequent events per turn.

**Migration**
- Remove all `precondition` logic from transports/agents.
- Default to omitting `turn` in clients; rely on orchestrator’s turn resolution.
- Advanced clients that set `turn` should expect validation errors if they attem
pt to open a new turn while one is open.

This spec keeps writing logic predictable, eliminates all preconditions, and rel
ies on a simple invariant: one open turn at a time. Agents just abort and contin
ue; the server handles turn continuity and blocks illegal new-turn opens.
