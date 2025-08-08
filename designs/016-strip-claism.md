Here’s a practical, no-mystery dev plan to (1) remove claims, (2) support **trace-opened turns** with a tiny state machine, and (3) enforce a **CAS precondition** (“compare-and-swap”) whenever a new turn is opened by either a trace or a message.

---

# Why this change (short + sweet)

* **Claims are heavy and leaky.** You don’t need a persistent “reservation” to prevent races; a simple **CAS at turn open** is enough.
* **Agents need to work before speaking.** Let **traces open a turn** into a `work` phase; only a **message** can finalize/close.
* **Optional guidance.** With CAS, correctness doesn’t depend on guidance or tickets; guidance can remain purely advisory/UX.

---

# Target behavior (spec)

1. **Opening a turn**

   * If **no turn is open**, the **first event** (trace *or* message) may open a new turn **only if** it carries a valid **precondition**:

     * `precondition.lastClosedSeq` must equal the storage’s current `lastClosedSeq` for the conversation.
     * **Initial turn**: precondition is optional; if omitted, it is treated as `lastClosedSeq = 0`.
   * If the first event is a **trace**, the turn begins in `phase='work'`.
   * If the first event is a **message**, it can both **open** the turn and (optionally) **finalize** it (`finality='turn'|'conversation'`).

2. **Working in a turn**

   * Additional **traces** may be appended while `phase='work'`.
   * The **first message** on that turn transitions the phase to **closed** with `finality='turn'` (or `'conversation'`).

3. **Closing a turn**

   * A **message** with `finality !== 'none'` closes the turn (`phase='closed'`).
   * A watchdog (optional) can auto-close **stalled** `work` phases after a timeout by emitting a `system{ kind:'idle_timeout' }` and marking the turn closed.

4. **Concurrency**

   * Multiple agents may race to open; **first CAS success wins**. Losers receive a `409 Conflict (precondition failed)` and can refresh.

---

# Step-by-step implementation plan

## 0) Prep & terminology

* We’ll keep all event types as-is; we’ll add a lightweight **turn phase** signal via system events.
* Storage must expose a quick **head** view per conversation: `{ lastTurn, lastClosedSeq, hasOpenTurn }`.

---

## 1) Remove the claims system (code deletions & cleanup)

### Delete / disable in Orchestrator

* **`src/server/orchestrator/orchestrator.ts`**

  * Remove:

    * `claimTurn(...)` method (and its exports/usages).
    * `startClaimWatchdog()` and related interval, `cleanupClaims()`.
    * Any references to `this.storage.turnClaims.*`.
  * Remove emission/handling of system events: `turn_claimed`, `claim_expired`.

### Delete types

* **`src/types/api.types.ts`**

  * Remove `ClaimTurnRequest`, `ClaimTurnResponse`.
* **`src/types/event.types.ts`**

  * Remove system payload kinds related to claims (`turn_claimed`, `claim_expired`).

### Delete storage layer for claims

* If you have a `turnClaims` store/table:

  * Drop it (migration below).
  * Remove code paths that read/write it.

### Tests to update/remove

* Remove tests referencing `claimTurn`, claim expiry, and claim watchdog behavior.

**Why:** Eliminates stateful reservations. CAS at append time will prevent double starts without the maintenance burden.

---

## 2) Add CAS precondition for **turn open** (trace or message)

### Types: API changes

* **`src/types/api.types.ts`**

  * Update `SendTraceRequest` / `SendMessageRequest`:

    ```ts
    export interface SendTraceRequest {
      conversationId: number;
      agentId: string;
      tracePayload: TracePayload;
      turn?: number; // omit to open a new turn
      precondition?: { lastClosedSeq: number }; // NEW (only required when opening a new turn)
    }

    export interface SendMessageRequest {
      conversationId: number;
      agentId: string;
      messagePayload: MessagePayload;
      finality: Finality;
      turn?: number; // omit to open a new turn
      precondition?: { lastClosedSeq: number }; // NEW (only required when opening a new turn)
    }
    ```

### Event store head metadata

* **Storage API** (wherever your `Storage.events` lives):

  * Add a fast method:
    `getHead(conversation): { lastTurn: number; lastClosedSeq: number; hasOpenTurn: boolean }`
  * Maintain:

    * `lastClosedSeq` = `seq` of the **most recent message** whose `finality !== 'none'`.
    * `hasOpenTurn` = whether the last turn lacks a closing message.

### Orchestrator append logic (single-transaction CAS)

* **`src/server/orchestrator/orchestrator.ts` → `appendEvent`**

  * Wrap event append in a **single storage transaction**.
  * Pseudocode:

    ```ts
    appendEvent(input) {
      return storage.events.withTransaction(() => {
        const head = storage.events.getHead(input.conversation);

        const openingNewTurn = input.turn == null; // caller didn’t specify a turn
        if (openingNewTurn) {
          // Initial turn can omit precondition (treated as 0)
          const requiredSeq = head.lastClosedSeq ?? 0;
          const providedSeq = input.precondition?.lastClosedSeq ?? 0;
          if (providedSeq !== requiredSeq) {
            throw new ConflictError('precondition failed');
          }
          const newTurn = (head.lastTurn ?? 0) + 1;

          // If first event is a trace, emit a system turn_started (phase='work')
          if (input.type === 'trace') {
            storage.events.insert({
              conversation: input.conversation,
              type: 'system',
              payload: { kind: 'note', data: { turn: newTurn, phase: 'work', opener: input.agentId } },
              finality: 'none',
              agentId: 'system-orchestrator'
            });
          }

          input.turn = newTurn;
        } else {
          // Appending to an existing turn:
          // Optionally assert the turn is not already closed.
          if (storage.events.isTurnClosed(input.conversation, input.turn)) {
            throw new ConflictError('turn already closed');
          }
        }

        // Optional: idempotency by clientRequestId (see §4).
        const res = storage.events.insert(input);

        // If closing message, mark turn closed (and update head.lastClosedSeq)
        if (input.type === 'message' && input.finality !== 'none') {
          storage.events.markTurnClosed(input.conversation, input.turn, res.seq);
        }

        // Post-write orchestration (scheduler) stays as-is, except no claim cleanup.
        return res;
      });
    }
    ```

* **Scheduler** (`onEventAppended`) remains the same except:

  * Remove any claim cleanup calls.
  * If you previously depended on claims to block concurrent guidance, you can leave guidance **optional**. Guidance decisions still trigger on closing messages (as you already do).

**Why:** CAS guarantees only one opener wins per conversation, independent of guidance.

---

## 3) Turn phases (super light) and idle watchdog (optional)

* We don’t introduce a persistent “turns” table; we **derive** phase or signal it via **system events** for UI/telemetry.

### System events

* On **trace-opened** turn: emit `system{ kind:'note', data:{ turn, phase:'work' } }`.
  (If you prefer, add a new `SystemPayload.kind: 'turn_started'`.)

* On **first message** with `finality !== 'none'`: implicitly `phase='closed'`.
  If you want explicitness, emit `system{ kind:'note', data:{ turn, phase:'closed' } }` after marking closed.

### Idle watchdog (optional)

* Replace claim watchdog with a **work-phase watchdog**:

  * Scan recent conversations; if you detect a turn last started with `phase='work'` and **no message** within `idleTurnMs`, emit:

    * `system{ kind:'idle_timeout', data:{ turn, at: ISO } }`
  * Then **mark the turn closed** (no finality message is synthesized; the next talker can open a new turn).
* This is optional if you’re okay with long-lived work phases.

**Why:** Gives visibility (“Agent working…”) and auto-cleans abandoned work without claims.

---

## 4) Idempotency & retries (messages **and** traces)

* **`src/types/event.types.ts`**

  * Add `clientRequestId?: string` to `TracePayload` (it’s already on `MessagePayload`).
* **Storage**

  * Add a **unique index** on `(conversation, clientRequestId)` across **message and trace** rows (null-skipping).
  * On conflict, return the prior event (idempotent behavior).

**Why:** Prevents dupes under retries and perfectly complements the CAS open.

---

## 5) API ergonomics & helper changes

* **`src/server/orchestrator/orchestrator.ts`**

  * Update `sendTrace(...)`:

    * If `turn` is omitted → you’re attempting to open a new turn; require `precondition`.
    * If an open `work` turn exists, you can omit both `turn` and `precondition`; you may attach to the open turn (implementation choice):

      * **Safer**: require explicit `turn` to append to open turn.
      * **Pragmatic**: auto-append to open turn by default.
  * Update `sendMessage(...)` similarly.

* **Convenience**: `getConversationSnapshot(...)` should add `lastClosedSeq` so clients know what to send in `precondition`.

---

## 6) Type & payload updates

* **`src/types/api.types.ts`** (done above).
* **`src/types/event.types.ts`**

  * Optionally add dedicated system kinds:

    ```ts
    export interface SystemPayload {
      kind: 'idle_timeout' | 'note' | 'meta_created' | 'meta_updated' | 'turn_started' | 'turn_phase_changed';
      data?: unknown;
      metadata?: unknown;
    }
    ```
  * If you add `turn_started`/`turn_phase_changed`, update orchestrator emissions accordingly.

---

## 7) Storage migrations (SQLite)

* **Drop claims table**

  ```sql
  -- if exists
  DROP TABLE IF EXISTS turn_claims;
  ```

* **Idempotency index**

  ```sql
  -- assuming events table has (conversation INTEGER, clientRequestId TEXT NULL, ...):
  CREATE UNIQUE INDEX IF NOT EXISTS idx_events_convo_clientreq
    ON events(conversation, clientRequestId)
    WHERE clientRequestId IS NOT NULL;
  ```

* **Head cache (optional but recommended)**

  * Either compute `lastClosedSeq` on the fly, or keep a small `conversation_heads` table updated in the same transaction:

  ```sql
  CREATE TABLE IF NOT EXISTS conversation_heads (
    conversation INTEGER PRIMARY KEY,
    lastTurn INTEGER NOT NULL DEFAULT 0,
    lastClosedSeq INTEGER NOT NULL DEFAULT 0,
    hasOpenTurn INTEGER NOT NULL DEFAULT 0
  );
  ```

  * Update `conversation_heads` whenever you insert a closing message or open a new turn.

---

## 8) Code changes in your tree (file-by-file)

* **`src/server/orchestrator/orchestrator.ts`**

  * Remove claims code (`claimTurn`, watchdog, cleanup).
  * Extend `appendEvent` to:

    * Read `head` inside a transaction.
    * Enforce CAS precondition when `turn` is omitted.
    * Allocate `newTurn` and emit `turn_started` (or `note phase='work'`) when a trace opens the turn.
    * On closing message, mark closed and update head.
  * Adjust `sendTrace`/`sendMessage` signatures to accept `precondition`.

* **`src/types/api.types.ts`**

  * Add `precondition` to send requests.
  * Remove claim types.

* **`src/types/event.types.ts`**

  * Add optional `clientRequestId` to `TracePayload`.
  * Optionally add `turn_started` / `turn_phase_changed` kinds.

* **`src/types/orchestrator.types.ts`**

  * `GuidanceEvent` untouched (remains optional).
  * Remove any claim-related references.

* **`src/server/orchestrator/storage/*` (wherever events live)**

  * Implement `getHead`, `isTurnClosed`, `markTurnClosed`, `withTransaction`.
  * Add/update indices for idempotency.

* **Agents**

  * **No change required** for your agents beyond sending `precondition` when **opening**.
  * For convenience, expose `lastClosedSeq` in hydration snapshot so the agent runtime can include it on first outbound event of a turn.

---

## 9) Test plan

### Unit tests (storage/orchestrator)

1. **CAS success opens turn with trace**

   * Given `lastClosedSeq = X`, first trace with `precondition=X` opens turn `N`, emits `turn_started`.
2. **CAS conflict**

   * Two concurrent open attempts with same `precondition`: one succeeds, one `409`.
3. **Message opens and closes**

   * Message with `precondition=X` opens turn and `finality='turn'` → `lastClosedSeq` updated.
4. **Append to open work phase**

   * Traces append to the same turn until a message closes it.
5. **Stalled work timeout (optional)**

   * No message within `idleTurnMs` → emit `idle_timeout`, mark closed.
6. **Idempotent traces/messages**

   * Same `(conversation, clientRequestId)` → one logical event.
7. **Initial turn without precondition**

   * First event opens with `precondition` omitted (treated as 0).

### Integration tests (agents)

1. **Trace before message**

   * Agent emits tool\_call trace, then tool\_result, then a message; all in same turn.
2. **Racing agents**

   * Two agents try to open: first wins; second gets conflict and retries.
3. **Guidance optionality**

   * No guidance emitted; agent still opens/works/closes turns.

---

## 10) Rollout plan

1. **PR 1: Types + storage head + idempotency index.**
2. **PR 2: Orchestrator `appendEvent` CAS & trace-opened turns.**
3. **PR 3: Remove claims system + delete dead code + migrations.**
4. **PR 4: Watchdog for `work` (optional) + UI tweaks (“working…” state).**
5. **PR 5: Tests & docs (README section “Turn semantics & preconditions”).**

---

## 11) Dev notes & gotchas

* **Require precondition only to open a new turn.**
  Appending to an **existing** turn should not require it (but you may still block if the turn is already closed).

* **Initial turn precondition**
  Treat omitted as `0` so older clients don’t break.

* **UI semantics**
  Don’t show “trace-only turns” as chat bubbles; show a “working…” banner until the first message arrives.

* **Scheduler**
  Keep it simple: it still triggers on closing messages. Guidance remains a hint, not a lock.

---

If you want, I can turn this into concrete diffs for `orchestrator.ts` and a tiny `eventStore` abstraction with `getHead/markTurnClosed` so it lands cleanly in your codebase.

