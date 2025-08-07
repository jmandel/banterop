## Design Doc — **Rich Conversation Metadata v1**

> **Goal:** At creation time a conversation carries a *compact, first-class* description
> of **who** is involved and the **scenario knobs** they’ll run with – while still
> leaving plenty of room for app-specific extras.

---

### 1 Core Principles

| Principle                    | Why it matters                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Explicit → discoverable**  | Agent IDs, roles, scenario ID, etc. live in typed columns / fields, not hidden in a blob.                      |
| **Namespaced extensibility** | Anything you invent later should slot into a namespaced object (`custom`) without schema changes.              |
| **Immutable metadata**       | Once created the metadata is *append-only* (edited by special “system” events) so every worker can rely on it. |

---

### 2 API Shape

#### 2.1 `POST /api/conversations`

```jsonc
{
  "title":       "Knee MRI Prior Auth",
  "description": "ACME Health demo flow",
  "scenarioId":  "prior-auth.v2",

  // Participants in deterministic order
  "agents": [
    {
      "id": "patient",          // required, unique
      "kind": "external",       // "internal" | "external"
      "role": "user",           // free-text label
      "displayName": "Pat Doe",
      "avatarUrl": "https://…/patient.png",

      // Opaque per-agent settings
      "config": {
        "language": "en-US",
        "allowedTools": ["upload-doc"]
      }
    },
    {
      "id": "insurer-assistant",
      "kind": "internal",
      "role": "assistant",
      "displayName": "Auto Reviewer Bot",
      "config": {
        "model": "gpt-4o-mini",
        "maxTurns": 4
      }
    }
  ],

  // Scenario-level tuning knobs (opaque)
  "config": {
    "idleTurnMs": 900000,
    "policy":     "strict-alternation"
  },

  // Anything else — your namespace, your rules
  "custom": {
    "tenantId": "acme-health",
    "tags": ["demo", "knee", "MRI"]
  }
}
```

*Response* (201):

```json
{
  "conversation": 42,
  "createdAt": "2025-08-07T12:34:56Z",
  "status": "active",
  // full metadata echoed back
  "metadata": { …same as above, plus server defaults… }
}
```

#### 2.2 TypeScript types (`src/types/conversation.meta.ts`)

```ts
export interface AgentMeta {
  id:           string;                 // slug, immutable
  kind:         "internal" | "external";
  role?:        string;
  displayName?: string;
  avatarUrl?:   string;
  config?:      Record<string, unknown>;
}

export interface ConversationMeta {
  title?:       string;
  description?: string;
  scenarioId?:  string;
  agents:       AgentMeta[];
  config?:      Record<string, unknown>;
  custom?:      Record<string, unknown>;   // namespaced ext
}
```

---

### 3 Storage Model

| Column         | Type       | Notes                                             |
| -------------- | ---------- | ------------------------------------------------- |
| `conversation` | INTEGER PK | unchanged                                         |
| `title`        | TEXT       | nullable                                          |
| `description`  | TEXT       | nullable                                          |
| `scenario_id`  | TEXT       | indexed                                           |
| `meta_json`    | TEXT       | **JSON string** holding: `{agents,config,custom}` |
| …              | …          | existing `status`, timestamps unchanged           |

*Rationale:*
Only the **append-heavy** part (agents + config) lives in
`meta_json`; high-filter fields (`scenario_id`, `title`) get native columns for WHERE/LIST queries.

> **No schema migration pain** – the old rows get `meta_json = '{}'`.

---

### 4 Event-Log Integration

* On **conversation creation** the orchestrator inserts the row **and** emits a
  synthetic system event:

```json
{ "type":"system",
  "payload": { "kind":"meta_created", "metadata": … },
  "finality":"none",
  "agentId":"system-orchestrator" }
```

Agents that join mid-flight can *either* replay the log or call
`GET /api/conversations/:id?includeMeta=true`.

* Later edits (rare) are modelled as additional
  `system {kind:"meta_updated", patch:{…}}`
  events – the DB row is also patched for fast queries.

---

### 5 SDK Exposure

```ts
interface ConversationSnapshot {
  conversation: number;
  status: "active" | "completed";
  metadata: ConversationMeta;   // NEW
  events: UnifiedEvent[];
}
```

Agents/helpers can fetch `snapshot.metadata.agents` to e.g. build a
“who’s allowed to speak” map.

---

### 6 Extensibility Guidelines

| Want to add…                                        | Put it…                                           | Example                               |
| --------------------------------------------------- | ------------------------------------------------- | ------------------------------------- |
| A new *first-class* engine feature (e.g. `dueDate`) | Add a column & top-level JSON field; bump schema. | `"dueDate":"2025-09-01"`              |
| Partner-specific flags                              | `metadata.custom.partnerX.whatever`               | `"custom":{"partnerX":{"algo":"v3"}}` |
| Additional per-agent knob                           | `agents[i].config.someKey`                        | `"config":{"temperature":0.2}`        |

> Namespace tip: use a reverse-DNS or org slug to avoid collisions.

---

### 7 What to **delete / simplify** in the codebase

* `scenario.types.ts` **no longer needs** its own `agents[]` definition – reuse `ConversationMeta.AgentMeta`.
* Old “creatorParams” blobs scattered in `cli/*` sims – replace with the new structured JSON.
* Remove ad-hoc parsing in `SimpleAlternationPolicy` that tried to guess internal vs external; it can now check `metadata.agents[*].kind`.

---

### 8 Testing Plan

| Layer               | Test                                               | Success criteria                                       |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| **Unit – DB**       | Insert row with full meta → read back              | Columns populated, `meta_json` round-trips loss-lessly |
| **API**             | POST create → GET snapshot                         | Snapshot includes `metadata` identical to input        |
| **Event log**       | create conv → verify first event `meta_created`    | Payload matches DB row                                 |
| **Backward compat** | Read legacy row (empty meta)                       | SDK returns `{agents:[],config:{},custom:{}}` defaults |
| **Agent loading**   | WorkerRunner builds prompt using `metadata.agents` | Internal/external classification matches expectation   |

---

### 9 Why this design?

* **Declarative & explicit** – agent IDs, scenario ID are machine-readable.
* **Flexible** – anything unknown is tolerated inside `config` / `custom`.
* **Low-touch migration** – one extra JSON column; no rewrite of event schema.
* **Single-source truth** – both DB row *and* first system event carry the same metadata, so stateless workers can reconstruct from log alone.

---

> **Next steps**:
>
> 1. Add column & JSONB field → migrate schema.
> 2. Implement validation in `POST /conversations`.
> 3. Replace legacy creators in tests & sims.

