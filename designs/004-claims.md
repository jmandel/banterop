# Migration Design Doc

**Towards “Guidance + Claim” turn-coordination, drop the polling maze**

---

## 0. Why we’re doing this

* **External executors** currently juggle `subscribe` + `tail` + `waitForChange` and re-build “is-it-my-turn?” logic.
* **Internal workers** use a *different* path (policy callback), so parity bugs creep in.
* We can make both paths stateless and < 40 LOC by letting the orchestrator emit **derived “guidance” events** and optionally honour a **`claim_turn`** lock.

---

## 1. Target model recap

| Concept                      | Shape in the log                                                                                 | Notes                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| **Guidance event**           | *Transient* WS fan-out: <br>`{type:'guidance', conversation, seq, nextAgentId, deadlineMs?}`     | *Not* written to `conversation_events`.     |
| **Turn claim**               | 1 × `system` event in the log: <br>`{kind:'turn_claimed', by:'agent-x', guidanceSeq, expiresAt}` | Real append-only record; replayable.        |
| **Flagged subscription**     | `subscribe({conversationId, includeGuidance?: boolean})`                                         | Power users set `false` to ignore guidance. |
| **Simplified client helper** | `eventStream(convId, {includeGuidance}) ➜ AsyncIterable<Event>`                                  | Handles reconnect, cursor, heart-beat.      |

Internal and external executors both:

```ts
for await (const ev of eventStream(convId)) {
  if (ev.type === 'guidance' && ev.nextAgentId === me) {
    if (await client.claimTurn({conversationId:convId, agentId:me, guidanceSeq:ev.seq})) {
      await agent.handleTurn(ctx);  // one turn, then loop
    }
  }
  if (ev.type === 'message' && ev.finality === 'conversation') break;
}
```

---

## 2. Migration plan

### Phase 0 — feature-flag scaffolding

* Add `orchestrator.cfg.emitGuidance` (default **off**).
* Add skeleton `claim_turn()` RPC that *always* returns `{ok:true}` but writes nothing yet.
  (Lets us merge new clients early.)

### Phase 1 — emit guidance

1. In `onEventAppended` (when a message finalises a turn) call:

   ```ts
   bus.publishGuidance({
     conversation: e.conversation,
     seq: e.seq + 0.1,           // any monotone cursor
     nextAgentId: policyDecision,
     deadlineMs: 30000
   });
   ```
2. **Do not persist**; it’s WS only.

### Phase 2 — implement `claim_turn`

* Create small SQLite table `turn_claims` (`PK (conversation, guidanceSeq)`).
* On success write the `system{turn_claimed}` event; on duplicate key return `{ok:false}`.
* Add watchdog that deletes the row and emits a `system{claim_expired}` note if no new `message` before `expiresAt`.

### Phase 3 — new shared client helper

* `src/agents/clients/event-stream.ts`
  – wraps WS subscribe, reconnect, heart-beat (retry every 15 s).
* Remove `waitForChange`, `getUpdatesOrGuidance` from `IAgentClient`.

### Phase 4 — external executor refactor

* Delete `external.executor.ts` (600+ LOC).
* Replace with `turn-loop.executor.ts` (< 70 LOC) using the snippet above.
* Drop `decideIfMyTurn`, `pollTimeoutMs`, etc.

### Phase 5 — internal executor alignment

* Replace `InternalExecutor.runOne()` + policy callback with the same turn-loop but wired to an **in-process** `eventStream` (wraps `SubscriptionBus`).
* Delete `worker-runner.ts` and `spawnInternalWorker` logic — no more hidden fork-off.

### Phase 6 — rip out legacy code

Safe to delete once all agents use the new loop:

| File / directory                                                                          | Why it goes away       |
| ----------------------------------------------------------------------------------------- | ---------------------- |
| `src/agents/clients/inprocess.client.ts` methods: `waitForChange`, `getUpdatesOrGuidance` | superseded             |
| `src/agents/clients/ws.client.ts` same methods + `ensureSubscribed` plumbing              | superseded             |
| `src/agents/external/external.executor.ts` & `simple.executor.ts`                         | replaced               |
| `src/server/orchestrator/worker-runner.ts` + `spawnInternalWorker` code path              | replaced               |
| Tests that exercise wait/poll logic (`*.executor.test.ts`, `wait_for_updates` parts)      | rewrite using guidance |

(Leave `tail()` read-path for dashboards; it’s still useful.)

---

## 3. Internal learning from the external path

External loop proved:

* **Async-iterator pattern** is easier to reason about than callbacks + polling.
* Having the *orchestrator* own fairness (via `guidance`) eliminates divergent client logic.
* `claim_turn` gives HA safety without coordination services (just SQLite row).

We now apply identical logic to internal agents:

| Before                                                                  | After                                                                                           |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Orchestrator decides **next internal agent** then calls bespoke worker. | Orchestrator *publishes* guidance → `InternalTurnLoop` reacts exactly like an external replica. |
| Complex “in-flight worker” guard.                                       | `turn_claims` table already prevents double work; guard is redundant.                           |

---

## 4. Backward-compat & rollout

1. **Ship guidance flag ON but keep old APIs.**
   New executors will ignore them; old executors still work.
2. Convert our internal workers first (nobody external notices).
3. Publish SDK vNext with new executor + deprecation warnings.
4. After partner uptake, remove code in Phase 6 and flip `emitGuidance` to *always* true.

---

## 5. Schema delta

```sql
CREATE TABLE turn_claims (
  conversation  INTEGER NOT NULL,
  guidance_seq  REAL    NOT NULL,
  agent_id      TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,
  PRIMARY KEY (conversation, guidance_seq)
);
```

No change to `conversation_events`.

---

## 6. Estimated effort

| Task                                             | Size               |
| ------------------------------------------------ | ------------------ |
| Emit guidance + tests                            | ½ day              |
| `claim_turn` endpoint + expiry daemon            | 1 day              |
| New client helper (`eventStream`)                | ½ day              |
| External executor rewrite                        | 1 day              |
| Internal executor rewrite & remove worker-runner | 1 day              |
| Clean-up & doc                                   | ½ day              |
| **Total**                                        | **\~4.5 dev-days** |

---

### Done → we get

* One tiny executor loop for **every** runtime (browser, Bun, Lambda, worker).
* No polling, no duplicate policy code.
* Fully auditable “who claimed what” system events.
