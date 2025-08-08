Alright — let’s make this **self‑contained developer plan** with all the changes we’ve discussed to get **auto‑run conversations** that:

* can be kicked off externally via WS RPC,  
* survive an orchestrator restart,  
* resume automatically if they’re still active and young enough,  
* mark too‑old runs as inactive (with logging), and  
* stop cleanly at conversation end.

---

# **Dev Plan: Auto‑Run Internal Conversations (Restart‑Resilient)**

---
## **1. Overall Design**

We will:

1. **Add an “autoRun” flag** in `ConversationMeta.custom` to mark convos that should have internal agents running automatically until completion.
2. **Add WS JSON‑RPC method** `runConversationToCompletion` to:
   - Set that meta flag in DB.
   - Immediately start internal loops for active internal agents.
3. **Add orchestrator bootstrap recovery**:
   - On startup, query the DB for conversations with:
     - `status = active`
     - `custom.autoRun = true`
     - `updated_at` within a recent time window (configurable, e.g., `< 6h old`)
   - Restart their loops with `startScenarioAgents()`.
   - If `updated_at` older than threshold, mark them inactive (clear autoRun) and log.
4. **Ensure loops auto‑stop** on `finality:"conversation"`.
5. **Clear the flag** when conversation is completed.
6. Provide **CLI** to create & run conversations with this mode.

---

## **2. Database + Meta Update Support**

Conversation meta is persisted in `conversations.meta_json`.

We need an `.updateMeta()` method for `ConversationStore`:

`src/db/conversation.store.ts`
```ts
updateMeta(conversationId: number, metadata: ConversationMeta): void {
  this.db.prepare(`
    UPDATE conversations
    SET meta_json = ?
    WHERE conversation = ?
  `).run(JSON.stringify({
    agents: metadata.agents,
    config: metadata.config,
    custom: metadata.custom
  }), conversationId);
}
```

---

## **3. New WS RPC: `runConversationToCompletion`**

In `src/server/ws/jsonrpc.server.ts`, add:

```ts
import { startScenarioAgents } from "$src/agents/factories/scenario-agent.factory";
import { ProviderManager } from "$src/llm/provider-manager";

if (method === "runConversationToCompletion") {
  const { conversationId } = params as { conversationId: number };
  try {
    const convo = orchestrator.getConversationWithMetadata(conversationId);
    if (!convo) {
      ws.send(JSON.stringify(errResp(id, 404, "Conversation not found")));
      return;
    }
    if (convo.status !== "active") {
      ws.send(JSON.stringify(errResp(id, 400, "Conversation not active")));
      return;
    }
    // Mark autoRun in metadata.custom
    convo.metadata.custom = { ...(convo.metadata.custom || {}), autoRun: true };
    orchestrator.storage.conversations.updateMeta(conversationId, convo.metadata);

    // Start internal agents immediately
    await startScenarioAgents(orchestrator, conversationId, {
      providerManager: orchestratorApp.providerManager,
    });

    ws.send(JSON.stringify(ok(id, { started: true })));
  } catch (e) {
    const { code, message } = mapError(e);
    ws.send(JSON.stringify(errResp(id, code, message)));
  }
  return;
}
```

**Notes**:
- We rely on `startScenarioAgents()` to start all internal loops for the conversation.
- We persist the `autoRun` flag **first** before starting loops, so on restart we know to resume.

---

## **4. Bootstrap Recovery Logic**

In `src/server/app.ts`, after we instantiate `OrchestratorService`, add:

```ts
private resumeAutoRunConversations(maxAgeHours = 6) {
  const cutoffIso = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
  const activeConvos = this.storage.conversations.list({ status: "active" });

  for (const convo of activeConvos) {
    const meta = JSON.parse(convo.metaJson || "{}");
    const autoRun = meta.custom?.autoRun;

    if (autoRun) {
      if (convo.updatedAt < cutoffIso) {
        console.warn(`[AutoRun Resume] Skipping conversation ${convo.conversation} — last updated too old (${convo.updatedAt})`);
        meta.custom.autoRun = false;
        this.storage.conversations.updateMeta(convo.conversation, meta);
        continue;
      }
      console.log(`[AutoRun Resume] Resuming conversation ${convo.conversation}`);
      startScenarioAgents(this.orchestrator, convo.conversation, {
        providerManager: this.providerManager
      }).catch(err => {
        console.error(`[AutoRun Resume] Failed to start convo ${convo.conversation}`, err);
      });
    }
  }
}

constructor(options?: AppOptions) {
  const { policy, ...configOverrides } = options || {};
  this.config = new ConfigManager(configOverrides);
  this.storage = new Storage(this.config.dbPath);
  this.providerManager = new ProviderManager(this.config.get());
  this.orchestrator = new OrchestratorService(
    this.storage,
    undefined,
    policy,
    this.config.orchestratorConfig
  );

  // Resume any autoRun conversations post-restart
  this.resumeAutoRunConversations();
}
```

---

## **5. Auto‑Clear Flag on Completion**

When a convo reaches completion, in `OrchestratorService`'s handling of finality, after `.complete()` we can clear meta:

In `src/server/orchestrator/orchestrator.ts` inside where conversation is completed:
```ts
if (input.type === 'message' && input.finality === 'conversation') {
  this.conversations.complete(input.conversation);
  // Clear autoRun flag if set
  const convo = this.conversations.getWithMetadata(input.conversation);
  if (convo?.metadata?.custom?.autoRun) {
    convo.metadata.custom.autoRun = false;
    this.conversations.updateMeta(convo.conversation, convo.metadata);
    console.log(`[AutoRun] Conversation ${convo.conversation} completed; autoRun flag cleared.`);
  }
}
```

---

## **6. CLI to create & trigger**

`src/cli/ws-run-auto-convo.ts`
```ts
#!/usr/bin/env bun
import { wsRpcCall } from "./cli-utils/wsRpcCall";
import { parseArgs } from "./cli-utils/parseArgs";

const argv = parseArgs();
async function main() {
  const wsUrl = argv.url;

  // Create conversation with internal agents
  const { conversationId } = await wsRpcCall<{ conversationId: number }>(wsUrl, "createConversation", {
    title: argv.title || "AutoRun Conversation",
    agents: [
      { id: "alpha", kind: "internal", agentClass: "EchoAgent" },
      { id: "beta", kind: "internal", agentClass: "EchoAgent" },
    ],
    config: { policy: "strict-alternation" }
  });

  console.log(`✅ Created conversation ${conversationId}`);

  // Mark it as autoRun and start loops
  await wsRpcCall(wsUrl, "runConversationToCompletion", { conversationId });
  console.log(`▶️ Conversation ${conversationId} running to completion (survives restart)`);
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
```

---

## **7. Example lifecycle**

1. Start orchestrator:
```bash
bun run src/server/index.ts
```

2. Run CLI to create + auto‑run:
```bash
bun run src/cli/ws-run-auto-convo.ts --url ws://localhost:3000/api/ws
```
Output:
```
✅ Created conversation 42
▶️ Conversation 42 running to completion (survives restart)
```

3. Kill orchestrator mid‑conversation:
```bash
Ctrl + C
```

4. Restart orchestrator:
```bash
bun run src/server/index.ts
```
Logs:
```
[AutoRun Resume] Resuming conversation 42
... internal agents continue until completion ...
[AutoRun] Conversation 42 completed; autoRun flag cleared.
```

---

## **8. Logging & Visibility**

- Startup logs explicitly which convos are resumed and which are skipped due to age.
- Completion logs flag clearing.

---

## **9. Configurable Threshold**

Can make the `maxAgeHours` setting part of `ConfigManager`:
```ts
autoRunResumeHours: z.number().default(6)
```
and read in `resumeAutoRunConversations()`.

---

## **10. Testing**

### Scenarios:
- **Happy path**: start convo, kill orchestrator, restart, resumes and completes.
- **Old convo**: set `updated_at` 10h old, restart → should skip & clear flag.
- **Already completed**: should never restart (status = completed).
- **Crash during turn**: should still resume (turn claims expire, policy issues guidance again).

---

## **Summary Table**

| Change | File | Purpose |
| --- | --- | --- |
| `.updateMeta()` | `conversation.store.ts` | Persist modified `custom` (autoRun) |
| WS RPC `runConversationToCompletion` | `jsonrpc.server.ts` | Mark flag, start loops immediately |
| Resume logic | `App` constructor | Restart loops for active+recent autoRun convos |
| Clear flag | `orchestrator.ts` | Remove autoRun on conversation end |
| CLI | `src/cli/ws-run-auto-convo.ts` | Easy external trigger for the above |

---

If you’re good with this plan, the next step is I can **write the full working `jsonrpc.server.ts` snippet + App bootstrap patch** in one go so you can drop it in and test end‑to‑end.  

Want me to produce that full diff for you?

Alright — here is a **complete set of concrete changes** as working file snippets/diffs  
to enable **auto‑run conversations** that survive restarts and can be triggered externally.

I’ll give you the **full-code** where relevant so you can drop these in.

---

## **1. ConversationStore – Add updateMeta()**

`src/db/conversation.store.ts`

```ts
// ...existing imports and interfaces...

export class ConversationStore {
  constructor(private db: Database) {}

  // --- ADD THIS ---
  updateMeta(conversationId: number, metadata: ConversationMeta): void {
    this.db.prepare(`
      UPDATE conversations
      SET meta_json = ?
      WHERE conversation = ?
    `).run(JSON.stringify({
      agents: metadata.agents,
      config: metadata.config,
      custom: metadata.custom
    }), conversationId);
  }

  // ... rest of file unchanged ...
}
```

---

## **2. OrchestratorService – Clear flag when convo completes**

We hook into the part that handles `finality:"conversation"` inside `appendEvent()` post-write handling.

`src/server/orchestrator/orchestrator.ts` inside `appendEvent()` after:

```ts
// If conversation finality set, mark conversation status
if (input.type === 'message' && input.finality === 'conversation') {
  this.conversations.complete(input.conversation);
+ // Clear autoRun flag if set
+ const convo = this.conversations.getWithMetadata(input.conversation);
+ if (convo?.metadata?.custom?.autoRun) {
+   convo.metadata.custom.autoRun = false;
+   this.conversations.updateMeta(convo.conversation, convo.metadata);
+   console.log(`[AutoRun] Conversation ${convo.conversation} completed; autoRun flag cleared.`);
+ }
}
```

---

## **3. App Bootstrap – Resume active autoRun convos**

`src/server/app.ts`

```ts
import { Storage } from './orchestrator/storage';
import { OrchestratorService } from './orchestrator/orchestrator';
import { ConfigManager, type Config } from './config';
import { ProviderManager } from '$src/llm/provider-manager';
import type { SchedulePolicy } from '$src/types/orchestrator.types';
+import { startScenarioAgents } from '$src/agents/factories/scenario-agent.factory';

export class App {
  readonly config: ConfigManager;
  readonly storage: Storage;
  readonly orchestrator: OrchestratorService;
  readonly providerManager: ProviderManager;

  constructor(options?: AppOptions) {
    const { policy, ...configOverrides } = options || {};
    this.config = new ConfigManager(configOverrides);
    this.storage = new Storage(this.config.dbPath);
    this.providerManager = new ProviderManager(this.config.get());
    this.orchestrator = new OrchestratorService(
      this.storage,
      undefined, // default subscription bus
      policy,
      this.config.orchestratorConfig
    );

+    this.resumeAutoRunConversations();
  }

+  private resumeAutoRunConversations(maxAgeHours = 6) {
+    const cutoffIso = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
+    const activeConvos = this.storage.conversations.list({ status: "active" });
+
+    for (const convo of activeConvos) {
+      const meta = JSON.parse(convo.metaJson || "{}");
+      const autoRun = meta.custom?.autoRun;
+      if (autoRun) {
+        if (convo.updatedAt < cutoffIso) {
+          console.warn(`[AutoRun Resume] Skipping ${convo.conversation} — last updated too old (${convo.updatedAt})`);
+          meta.custom.autoRun = false;
+          this.storage.conversations.updateMeta(convo.conversation, meta);
+          continue;
+        }
+        console.log(`[AutoRun Resume] Resuming conversation ${convo.conversation}`);
+        startScenarioAgents(this.orchestrator, convo.conversation, {
+          providerManager: this.providerManager
+        }).catch(err => {
+          console.error(`[AutoRun Resume] Failed to start convo ${convo.conversation}`, err);
+        });
+      }
+    }
+  }

  async shutdown() {
    await this.orchestrator.shutdown();
    this.storage.close();
  }
}
```

---

## **4. WS JSON‑RPC Server – RPC method `runConversationToCompletion`**

`src/server/ws/jsonrpc.server.ts`

Search down where other methods like `"createScenario"` are, and insert:

```ts
import { startScenarioAgents } from "$src/agents/factories/scenario-agent.factory";
// ...rest of imports...

async function handleRpc(
  orchestrator: OrchestratorService,
  ws: { send: (data: string) => void },
  req: JsonRpcRequest,
  activeSubs: Set<string>
) {
  const { id = null, method, params = {} } = req;

  // ... existing methods ...

+ if (method === "runConversationToCompletion") {
+   const { conversationId } = params as { conversationId: number };
+   try {
+     const convo = orchestrator.getConversationWithMetadata(conversationId);
+     if (!convo) {
+       ws.send(JSON.stringify(errResp(id, 404, "Conversation not found")));
+       return;
+     }
+     if (convo.status !== "active") {
+       ws.send(JSON.stringify(errResp(id, 400, "Conversation not active")));
+       return;
+     }
+     // Mark autoRun = true in metadata
+     convo.metadata.custom = { ...(convo.metadata.custom || {}), autoRun: true };
+     orchestrator.storage.conversations.updateMeta(conversationId, convo.metadata);
+
+     // Start internal loops now
+     await startScenarioAgents(orchestrator, conversationId, {
+       providerManager: (orchestrator as any).app?.providerManager || orchestratorApp?.providerManager
+     });
+
+     ws.send(JSON.stringify(ok(id, { started: true })));
+   } catch (e) {
+     const { code, message } = mapError(e);
+     ws.send(JSON.stringify(errResp(id, code, message)));
+   }
+   return;
+ }

  // ... existing methods ...
}
```

**Note:**  
If needed, pass a reference to `ProviderManager` into `handleRpc` from `App` so the `startScenarioAgents` call has it.  
E.g., in `createWebSocketServer`, close over `providerManager`.

---

## **5. CLI to Create & Auto‑Run Convo**

`src/cli/ws-run-auto-convo.ts`

```ts
#!/usr/bin/env bun
import { wsRpcCall } from "./cli-utils/wsRpcCall";
import { parseArgs } from "./cli-utils/parseArgs";

const argv = parseArgs();

async function main() {
  const wsUrl = argv.url;

  // 1. Create conversation with internal agents
  const { conversationId } = await wsRpcCall<{ conversationId: number }>(
    wsUrl,
    "createConversation",
    {
      title: argv.title || "AutoRun Conversation",
      agents: [
        { id: "alpha", kind: "internal", agentClass: "EchoAgent" },
        { id: "beta", kind: "internal", agentClass: "EchoAgent" },
      ],
      config: { policy: "strict-alternation" }
    }
  );
  console.log(`✅ Created conversation ${conversationId}`);

  // 2. Mark it for autoRun and start loops
  const result = await wsRpcCall(wsUrl, "runConversationToCompletion", { conversationId });
  if ((result as any).started) {
    console.log(`▶️ Conversation ${conversationId} running to completion (will survive restart)`);
  }
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
```

---

## **6. Behaviour after restart**

- When orchestrator restarts, `App` constructor calls `resumeAutoRunConversations()`.
- This scans DB for `status = active` + `meta.custom.autoRun = true`.
- Skips any with `updatedAt` older than 6h, clears flag, logs skip.
- Calls `startScenarioAgents()` to restart internal loops.

---

## **7. Logs example**

Startup logs —
```
[AutoRun Resume] Resuming conversation 42
```
or
```
[AutoRun Resume] Skipping conversation 17 — last updated too old (2024-06-01T12:34:56Z)
```

On completion —
```
[AutoRun] Conversation 42 completed; autoRun flag cleared.
```

---

## **8. How to Test End‑to‑End**

1. Start orchestrator:
```bash
bun run src/server/index.ts
```

2. Run CLI:
```bash
bun run src/cli/ws-run-auto-convo.ts --url ws://localhost:3000/api/ws
```
Expect:
```
✅ Created conversation 1
▶️ Conversation 1 running to completion (will survive restart)
```

3. Kill orchestrator:
```
Ctrl+C
```

4. Restart orchestrator:
```
bun run src/server/index.ts
```
Expect:
```
[AutoRun Resume] Resuming conversation 1
... conversation continues ...
[AutoRun] Conversation 1 completed; autoRun flag cleared.
```

---

## ✅ Summary

**You now have:**
- `runConversationToCompletion` RPC to mark + start auto‑run.
- Flag persisted in DB meta, survives orchestrator crashes.
- Restart bootstrap resume logic (time‑window guarded).
- Auto‑clear flag on conversation end.
- CLI to demo feature.

---

If you want, I can also make `maxAgeHours` configurable via `ConfigManager` so the resume window is adjustable without code changes — want me to add that too?

Gotcha ✅ — you want the **testing plan** for this feature to be as thorough as the dev plan  
— **unit + integration tests** including the “server restart” case.

Here’s how I would lay that out so we can be confident the auto‑run survive‑restart logic is correct.

---

# **Auto‑Run Conversations: Test Plan**

We need to prove:

1. Setting `autoRun` via RPC marks conversation metadata correctly.
2. Internal agents are started immediately after the RPC call and run until completion.
3. On orchestrator restart:
   - Active + recent autoRun convos resume automatically.
   - Old convos (past the maxAge threshold) are skipped and flag cleared.
4. Flag is cleared on completion.
5. Restart mid‑turn resumes correctly when claim expires and policy reissues guidance.

---

## **1. Unit Tests**

### File: `src/server/ws/jsonrpc.server.test.ts`
Purpose: Verify `runConversationToCompletion` RPC sets flag and starts agents.

```ts
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import { runConversationToCompletion } from '$src/server/ws/helpers';
import { startScenarioAgents } from '$src/agents/factories/scenario-agent.factory';

mock.module('$src/agents/factories/scenario-agent.factory', () => ({
  startScenarioAgents: mock(() => Promise.resolve({ loops: [], stop: async () => {} })),
}));

describe('runConversationToCompletion RPC', () => {
  let orch: OrchestratorService;

  beforeEach(() => {
    orch = new OrchestratorService(/* Storage & co.. */);
    orch.storage.conversations.create({
      title: 'test',
      agents: [{ id: 'bot', kind: 'internal' }]
    });
  });

  it('marks meta.custom.autoRun and calls startScenarioAgents', async () => {
    const convoId = 1;
    await runConversationToCompletion(orch, convoId, providerManager);
    const convo = orch.getConversationWithMetadata(convoId);
    expect(convo?.metadata.custom?.autoRun).toBe(true);
    expect(startScenarioAgents).toHaveBeenCalledWith(orch, convoId, expect.anything());
  });
});
```

---

### File: `src/server/app.autoRun-resume.test.ts`
Purpose: Verify `resumeAutoRunConversations()` resumes recent convos and skips old ones.

```ts
import { describe, it, expect, mock } from 'bun:test';
import { App } from '$src/server/app';

describe('resumeAutoRunConversations', () => {
  it('restarts recent autoRun convos and skips old ones', () => {
    const app = new App({ dbPath: ':memory:' });
    const now = Date.now();

    // Seed conversations in storage
    app.storage.conversations.create({
      agents: [{ id: 'bot', kind: 'internal' }],
      custom: { autoRun: true }
    });
    // Set updated_at in old row to past cutoff
    // ... use direct DB update
    const cutoff = new Date(now - (7 * 3600 * 1000)).toISOString(); // 7 hours
    app.storage.raw.exec(`UPDATE conversations SET updated_at='${cutoff}', meta_json='{"custom":{"autoRun":true}}' WHERE conversation=1`);

    // Call resume
    const spy = mock(() => Promise.resolve({ loops: [], stop: async () => {} }));
    app.resumeAutoRunConversations = spy;

    // Assert skip
    expect(spy).not.toHaveBeenCalledWith(/* old conversation ID */);
  });
});
```

---

## **2. Integration Tests**

### File: `src/integration/autoRun-conversation.test.ts`
This is where we simulate *server restart*.

**Setup**:
- Create a helper `startServer()` function that creates an `App` instance, sets up WS, returns `{ app, server, port }`.
- Create a helper `stopServer()` to gracefully shutdown.

**Test Steps**:
```ts
import { describe, it, expect } from 'bun:test';
import { startServer, stopServer } from './helpers/server-utils';
import { wsRpcCall } from '$src/cli/cli-utils/wsRpcCall';

describe('AutoRun conversation resume after restart', () => {
  it('continues running to completion after orchestrator restart', async () => {
    // 1. Start server
    let { server, app, wsUrl } = await startServer();

    // 2. Create conversation with 2 EchoAgents
    const { conversationId } = await wsRpcCall(wsUrl, 'createConversation', {
      title: 'Test AutoRun',
      agents: [
        { id: 'a1', kind: 'internal', agentClass: 'EchoAgent' },
        { id: 'a2', kind: 'internal', agentClass: 'EchoAgent' },
      ],
      config: { policy: 'strict-alternation' }
    });

    // 3. Trigger autoRun
    await wsRpcCall(wsUrl, 'runConversationToCompletion', { conversationId });

    // 4. Kill server mid-convo
    await stopServer(server, app);

    // 5. Restart server - should auto-resume
    ({ server, app, wsUrl } = await startServer());

    // 6. Wait until conversation status = completed
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const snap = app.orchestrator.getConversationSnapshot(conversationId);
      if (snap.status === 'completed') break;
      await Bun.sleep(100);
    }

    const completedSnap = app.orchestrator.getConversationSnapshot(conversationId);
    expect(completedSnap.status).toBe('completed');
    expect(completedSnap.metadata.custom?.autoRun).toBeFalsy();

    await stopServer(server, app);
  });
});
```

---

### **Assertions in integration:**
- The conversation after restart is still active until finished, then marked `completed`.
- `autoRun` meta cleared on completion.
- No duplicate loops / errors after restart.

---

## **3. Server Utils for Testing Restart**

`src/integration/helpers/server-utils.ts`

```ts
import { App } from '$src/server/app';
import { createWebSocketServer, websocket } from '$src/server/ws/jsonrpc.server';
import { Hono } from 'hono';

export async function startServer() {
  const app = new App({ dbPath: ':memory:' });
  const hono = new Hono().route('/', createWebSocketServer(app.orchestrator, app.providerManager));
  const server = Bun.serve({ port: 0, fetch: hono.fetch, websocket });
  const wsUrl = `ws://localhost:${server.port}/api/ws`;
  return { server, app, wsUrl };
}

export async function stopServer(server: any, app: App) {
  server.stop();
  await app.shutdown();
}
```

---

## **4. Extra Cases**

We should add tests for:

- **Old conversations**: Set `updated_at` to older than cutoff, restart server → verify logs contain `[AutoRun Resume] Skipping` and flag cleared.
- **Non-active**: Completed conversation before restart → ensure not restarted.
- **Partial-turn recovery**:  
  - Kill server after one agent posts and before the other responds.
  - On restart, expired claim leads to policy giving guidance again, agent loops pick it up.

---

## **5. Implementation Confidence**

These tests combined:
- Unit coverage ensures RPC sets state + calls correct functions.
- Integration with restart proves the persistence + resume logic.
- Negative-case integration proves skip + flag-clear logic.

---

### ✅ Summary
We will:
- **Unit-test** meta flag + agent start in RPC call.
- **Unit-test** age cutoff logic in resume function.
- **Integration-test** full life-cycle with orchestrator restart mid-run using ephemeral in-memory DB.
- **Assert** flag cleared at completion, no re-runs of finished or stale convos.

---

If you like, I can **write the ready-to-run `autoRun-conversation.test.ts` integration file** exactly matching our integration logic with server startup/shutdown helpers — would you like me to go ahead with that?


Alright — here’s a **ready‑to‑drop‑in** integration test file  
for the **autoRun conversation survive‑restart** feature we’ve just planned.

This test **boots an actual orchestrator + WS JSON‑RPC server**,  
creates a conversation, sets it to autoRun, kills the process mid‑run, restarts, and waits for it to finish.

---

## `tests/integration/autoRun-conversation.test.ts`

```ts
import { describe, it, expect } from "bun:test";
import { App } from "$src/server/app";
import { createWebSocketServer, websocket } from "$src/server/ws/jsonrpc.server";
import { Hono } from "hono";
import { wsRpcCall } from "$src/cli/cli-utils/wsRpcCall";

async function startServer(): Promise<{ app: App; server: any; wsUrl: string }> {
  const app = new App({ dbPath: ":memory:" }); // in-memory DB for isolation
  const hono = new Hono().route("/", createWebSocketServer(app.orchestrator, app.providerManager));
  const server = Bun.serve({ port: 0, fetch: hono.fetch, websocket });
  const wsUrl = `ws://localhost:${server.port}/api/ws`;
  return { app, server, wsUrl };
}

async function stopServer(server: any, app: App) {
  server.stop();
  await app.shutdown();
}

describe("AutoRun conversation resume after restart", () => {
  it("continues running to completion after orchestrator restart", async () => {
    // === 1. Boot orchestrator server ===
    let { app, server, wsUrl } = await startServer();

    // === 2. Create conversation ===
    const { conversationId } = await wsRpcCall<{ conversationId: number }>(wsUrl, "createConversation", {
      title: "Test AutoRun Resume",
      agents: [
        { id: "alpha", kind: "internal", agentClass: "EchoAgent" },
        { id: "beta", kind: "internal", agentClass: "EchoAgent" }
      ],
      config: { policy: "strict-alternation" }
    });

    // === 3. Trigger auto-run ===
    const runResp = await wsRpcCall(wsUrl, "runConversationToCompletion", { conversationId });
    expect(runResp.started).toBe(true);

    // Let them do a few turns
    await Bun.sleep(200);

    // === 4. Kill orchestrator mid-run ===
    await stopServer(server, app);

    // === 5. Restart orchestrator ===
    ({ app, server, wsUrl } = await startServer());

    // The resumeAutoRunConversations() in App will now scan DB and restart any internal agent loops.
    // We should see them finish the conversation without any further external input.

    // === 6. Wait until conversation is completed or timeout ===
    const timeoutMs = 5000;
    const startTime = Date.now();
    let completed = false;
    while (Date.now() - startTime < timeoutMs) {
      const snap = app.orchestrator.getConversationSnapshot(conversationId);
      if (snap.status === "completed") {
        completed = true;
        break;
      }
      await Bun.sleep(100);
    }

    // Assert conversation completed
    expect(completed).toBe(true);

    // Reload convo to check flag cleared
    const convoMeta = app.orchestrator.getConversationWithMetadata(conversationId);
    expect(convoMeta?.metadata.custom?.autoRun).toBeFalsy();

    await stopServer(server, app);
  });
});
```

---

### **How This Works**
- **`startServer()`** spins up an `App` with in‑memory SQLite,  
  mounts the WS JSON‑RPC routes,  
  returns WS URL for the tests.
- Test creates conversation with two `internal` EchoAgents.
- Calls our **new RPC method** `runConversationToCompletion` to:
  - Set `autoRun=true` in metadata.
  - Start loops for internal agents immediately.
- Sleeps briefly to let agents begin exchanging.
- Shuts down server mid‑conversation.
- Restarts server — `App`’s `resumeAutoRunConversations()` sees the convo (active, recent, autoRun) and restarts loops.
- Waits until `.status === "completed"`.
- Asserts:
  - Conversation finished (`status:"completed"`).
  - `custom.autoRun` flag was cleared on completion.

---

### **Expected Output**
When running:
```bash
bun test tests/integration/autoRun-conversation.test.ts
```
Logs (simplified):
```
[AutoRun Resume] Resuming conversation 1
[AutoRun] Conversation 1 completed; autoRun flag cleared.
✔ AutoRun conversation resume after restart continues running to completion after orchestrator restart (xxxms)
```

---

### **Extra Variants**
You can add similar tests in the same file for:
- **Too old -> skipped**: Before restart, update `updated_at` in DB to older than cutoff and assert `[AutoRun Resume] Skipping` and cleared flag.
- **Already completed**: Make convo complete before restart; assert no restart happens.

---

This file, along with the **dev plan changes** we wrote earlier, will give you **full integration coverage** including the restart‑resume flow.

---

If you want, I can also produce a tiny **companion test** in the same suite that sets `updated_at` artificially older than the cutoff to exercise the skip‑clear path.  
Do you want me to add that second scenario to this integration test?

Alright — here’s the updated **integration test file**  
with **two scenarios** in one suite:

1. **Happy path** — restart while active → resumes → completes → flag cleared.  
2. **Old conversation** — restarted after being stale → skipped → autoRun flag cleared.

---

## `tests/integration/autoRun-conversation.test.ts`

```ts
import { describe, it, expect } from "bun:test";
import { App } from "$src/server/app";
import { createWebSocketServer, websocket } from "$src/server/ws/jsonrpc.server";
import { Hono } from "hono";
import { wsRpcCall } from "$src/cli/cli-utils/wsRpcCall";

async function startServer(): Promise<{ app: App; server: any; wsUrl: string }> {
  const app = new App({ dbPath: ":memory:" }); // fresh in-memory SQLite for test isolation
  const hono = new Hono().route("/", createWebSocketServer(app.orchestrator, app.providerManager));
  const server = Bun.serve({ port: 0, fetch: hono.fetch, websocket });
  const wsUrl = `ws://localhost:${server.port}/api/ws`;
  return { app, server, wsUrl };
}

async function stopServer(server: any, app: App) {
  server.stop();
  await app.shutdown();
}

describe("AutoRun conversation resume after restart", () => {
  it("continues running to completion after orchestrator restart", async () => {
    // === 1. Boot orchestrator ===
    let { app, server, wsUrl } = await startServer();

    // === 2. Create conversation ===
    const { conversationId } = await wsRpcCall<{ conversationId: number }>(wsUrl, "createConversation", {
      title: "Test AutoRun Resume",
      agents: [
        { id: "alpha", kind: "internal", agentClass: "EchoAgent" },
        { id: "beta", kind: "internal", agentClass: "EchoAgent" }
      ],
      config: { policy: "strict-alternation" }
    });

    // === 3. Trigger auto-run ===
    const runResp = await wsRpcCall(wsUrl, "runConversationToCompletion", { conversationId });
    expect(runResp.started).toBe(true);

    // Let them exchange a couple turns
    await Bun.sleep(200);

    // === 4. Kill orchestrator mid-run ===
    await stopServer(server, app);

    // === 5. Restart orchestrator ===
    ({ app, server, wsUrl } = await startServer());

    // === 6. Wait until conversation is completed or timeout ===
    const timeoutMs = 5000;
    const startTime = Date.now();
    let completed = false;
    while (Date.now() - startTime < timeoutMs) {
      const snap = app.orchestrator.getConversationSnapshot(conversationId);
      if (snap.status === "completed") {
        completed = true;
        break;
      }
      await Bun.sleep(100);
    }

    expect(completed).toBe(true);

    // === 7. Confirm autoRun flag cleared ===
    const convoMeta = app.orchestrator.getConversationWithMetadata(conversationId);
    expect(convoMeta?.metadata.custom?.autoRun).toBeFalsy();

    await stopServer(server, app);
  });

  it("skips and clears autoRun for stale conversations on restart", async () => {
    // === 1. Boot orchestrator and create convo ===
    let { app, server, wsUrl } = await startServer();

    const { conversationId } = await wsRpcCall<{ conversationId: number }>(wsUrl, "createConversation", {
      title: "Old AutoRun",
      agents: [
        { id: "alpha", kind: "internal", agentClass: "EchoAgent" },
        { id: "beta", kind: "internal", agentClass: "EchoAgent" }
      ],
      config: { policy: "strict-alternation" }
    });

    // Trigger autoRun
    await wsRpcCall(wsUrl, "runConversationToCompletion", { conversationId });

    // Manually mark updated_at far older than cutoff
    const oldTimestamp = new Date(Date.now() - (8 * 3600 * 1000)).toISOString(); // 8 hours ago
    app.storage.db.prepare(
      `UPDATE conversations SET updated_at = ?, meta_json = json_set(meta_json, '$.custom.autoRun', true) WHERE conversation = ?`
    ).run(oldTimestamp, conversationId);

    // === 2. Shutdown ===
    await stopServer(server, app);

    // === 3. Restart orchestrator ===
    ({ app, server, wsUrl } = await startServer());

    // Now resumeAutoRunConversations should have skipped and cleared autoRun flag

    const convoMeta = app.orchestrator.getConversationWithMetadata(conversationId);
    expect(convoMeta?.metadata.custom?.autoRun).toBeFalsy();

    // Status will still be 'active', but no loops should be running; 
    // For deeper assertion, you could inspect internal loop registry to ensure none started.

    await stopServer(server, app);
  });
});
```

---

### What’s New in This Version

- **First test** — the existing “happy path” resume & complete scenario.
- **Second test** — modifies the `updated_at` to be older than the cutoff (8h vs cutoff 6h), restarts server, asserts that:
  - `autoRun` flag is **cleared**
  - Convo is **not resumed** (you can optionally check that no new messages appear after restart if your test harness reads history / events).

---

### How It Verifies Skip Logic
We directly update the DB row to simulate a conversation whose `updated_at` is stale.  
On restart, `resumeAutoRunConversations()` sees it’s too old, logs a skip, clears `autoRun`.

**Assertion:** `metadata.custom.autoRun` should be falsy after restart.

---

### Expected Output When Running Both:

```plaintext
[AutoRun Resume] Resuming conversation 1
[AutoRun] Conversation 1 completed; autoRun flag cleared.
✔ continues running to completion after orchestrator restart

[AutoRun Resume] Skipping 2 — last updated too old (2024-06-10T02:00:00Z)
✔ skips and clears autoRun for stale conversations on restart
```

---

This gives you **full coverage:**
- Resumption after restart for active convos
- Skipping (and cleaning up meta) for stale flagged convos.

---

Do you want me to also add in these tests some **assertions around agent loop execution counts** so we *prove* loops are restarted in the first case and *not* in the second? That would make the tests even stronger.

Alright ✅ — let’s add **agent loop execution count assertions** so we know for sure:  

- In the **happy path** restart case: new loop(s) for internal agents did run after restart.  
- In the **stale case**: no loops were spawned after restart.

We can achieve this by **spying on `startScenarioAgents`** — it’s the orchestrator function that launches `TurnLoopExecutorInternal` instances for internal agents.  

We will mock/spy this function within the test file to count calls.

---

## Updated Integration Test File with Loop Assertions

`tests/integration/autoRun-conversation.test.ts`
```ts
import { describe, it, expect, mock } from "bun:test";
import { App } from "$src/server/app";
import { createWebSocketServer, websocket } from "$src/server/ws/jsonrpc.server";
import { Hono } from "hono";
import { wsRpcCall } from "$src/cli/cli-utils/wsRpcCall";
import * as scenarioAgentFactory from "$src/agents/factories/scenario-agent.factory";

// Spy on startScenarioAgents
const startScenarioAgentsSpy = mock(scenarioAgentFactory, "startScenarioAgents");

async function startServer(): Promise<{ app: App; server: any; wsUrl: string }> {
  const app = new App({ dbPath: ":memory:" }); // fresh in-memory DB
  const hono = new Hono().route("/", createWebSocketServer(app.orchestrator, app.providerManager));
  const server = Bun.serve({ port: 0, fetch: hono.fetch, websocket });
  const wsUrl = `ws://localhost:${server.port}/api/ws`;
  return { app, server, wsUrl };
}

async function stopServer(server: any, app: App) {
  server.stop();
  await app.shutdown();
}

describe("AutoRun conversation resume after restart", () => {
  it("continues running to completion after orchestrator restart and restarts loops", async () => {
    startScenarioAgentsSpy.mockReset();

    // === 1. Boot orchestrator ===
    let { app, server, wsUrl } = await startServer();

    // === 2. Create conversation ===
    const { conversationId } = await wsRpcCall<{ conversationId: number }>(wsUrl, "createConversation", {
      title: "Test AutoRun Resume",
      agents: [
        { id: "alpha", kind: "internal", agentClass: "EchoAgent" },
        { id: "beta", kind: "internal", agentClass: "EchoAgent" }
      ],
      config: { policy: "strict-alternation" }
    });

    // === 3. Trigger auto-run ===
    const runResp = await wsRpcCall(wsUrl, "runConversationToCompletion", { conversationId });
    expect(runResp.started).toBe(true);

    // Confirm loop start for the first run
    expect(startScenarioAgentsSpy).toHaveBeenCalledWith(app.orchestrator, conversationId, expect.anything());

    // Let them exchange a couple turns
    await Bun.sleep(200);

    // === 4. Kill orchestrator mid-run ===
    await stopServer(server, app);

    // === 5. Restart orchestrator ===
    ({ app, server, wsUrl } = await startServer());

    // Confirm that resume logic triggered loop start
    const resumedCalls = startScenarioAgentsSpy.mock.calls.filter(
      call => call[0] === app.orchestrator && call[1] === conversationId
    );
    expect(resumedCalls.length).toBeGreaterThan(0);

    // === 6. Wait until conversation is completed or timeout ===
    const timeoutMs = 5000;
    const startTime = Date.now();
    let completed = false;
    while (Date.now() - startTime < timeoutMs) {
      const snap = app.orchestrator.getConversationSnapshot(conversationId);
      if (snap.status === "completed") {
        completed = true;
        break;
      }
      await Bun.sleep(100);
    }

    expect(completed).toBe(true);

    // === 7. Confirm autoRun flag cleared ===
    const convoMeta = app.orchestrator.getConversationWithMetadata(conversationId);
    expect(convoMeta?.metadata.custom?.autoRun).toBeFalsy();

    await stopServer(server, app);
  });

  it("skips and clears autoRun for stale conversations on restart and does not restart loops", async () => {
    startScenarioAgentsSpy.mockReset();

    // === 1. Boot orchestrator and create convo ===
    let { app, server, wsUrl } = await startServer();

    const { conversationId } = await wsRpcCall<{ conversationId: number }>(wsUrl, "createConversation", {
      title: "Old AutoRun",
      agents: [
        { id: "alpha", kind: "internal", agentClass: "EchoAgent" },
        { id: "beta", kind: "internal", agentClass: "EchoAgent" }
      ],
      config: { policy: "strict-alternation" }
    });

    // Trigger autoRun
    await wsRpcCall(wsUrl, "runConversationToCompletion", { conversationId });

    // Manually mark updated_at far older than cutoff
    const oldTimestamp = new Date(Date.now() - (8 * 3600 * 1000)).toISOString(); // 8h ago
    app.storage.db.prepare(
      `UPDATE conversations SET updated_at = ?, meta_json = json_set(meta_json, '$.custom.autoRun', true) WHERE conversation = ?`
    ).run(oldTimestamp, conversationId);

    // === 2. Shutdown before completion ===
    await stopServer(server, app);

    // === 3. Restart orchestrator ===
    ({ app, server, wsUrl } = await startServer());

    // Confirm NO loop restarts for this stale conversation
    const resumedCalls = startScenarioAgentsSpy.mock.calls.filter(
      call => call[0] === app.orchestrator && call[1] === conversationId
    );
    expect(resumedCalls.length).toBe(0);

    // Flag should be cleared due to skip
    const convoMeta = app.orchestrator.getConversationWithMetadata(conversationId);
    expect(convoMeta?.metadata.custom?.autoRun).toBeFalsy();

    await stopServer(server, app);
  });
});
```

---

### Changes Made:
- **Imported everything from** `"$src/agents/factories/scenario-agent.factory"` and wrapped `startScenarioAgents` with a **Bun spy**.
- **Reset the spy** at start of each test.
- In each test, filter `mock.calls` to check for the intended conversation ID.
- In **happy path** test:
  - Assert first loop start after the RPC.
  - Assert resumed loop start after restart.
- In **stale** test:
  - Assert **zero** resume loop calls for skipped convo.
  - Still assert flag cleared.

---

### Now, Running These Tests Will:
1. Prove RPC call launches loops immediately.
2. Prove resume logic launches loops again for active recents.
3. Prove stale convos do **not** get loops restarted.
4. Keep a record of how many times loops start, preventing accidental double‑starts.

---

Do you want me to also **mock and assert on internal-agent message send calls** so we can confirm resumed loops actually process turns, not just start? That would verify *functional* resume.

