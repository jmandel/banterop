Alright — let's lay this out as a proper **rip‑and‑replace developer plan**.  
The goal is: **remove** the old duplicative “loop executor” layer completely, move all turn‑claiming/snapshot looping into a unified `BaseAgent`, switch all agents to extend it, and update tests accordingly.

I'm going to treat this as a change request written for a teammate who's going to implement it.

---

# 🛠 Developer Plan — Remove Loop Executors, Unify Agent Runtime

> **Objective:** Replace `TurnLoopExecutorInternal` and `TurnLoopExecutorExternal` with a single `BaseAgent` that encapsulates:
> - Event subscription
> - Turn claim negotiation
> - Stable + live snapshots
> - Transport abstraction (internal or WS)
>  
> All agents become subclasses of `BaseAgent` and implement `takeTurn()` only.

---

## 0. **Scope and Risks**

- No compatibility layer — anything referencing `TurnLoopExecutorInternal`/`External` will be updated or deleted.
- All `start()` logic on agents becomes `BaseAgent.start(conversationId, agentId)`.
- `InProcessEventStream`, `WsEventStream`, etc. will no longer be used *inside* agents — replaced by `IAgentEvents` interface.
- All relevant tests will need updating to use the new startup pattern.

---

## 1. **Define the new interfaces**

Add a new shared file, e.g. `src/agents/runtime/runtime.interfaces.ts`:

```ts
import type { StreamEvent } from '$src/agents/clients/event-stream';

export interface IAgentTransport {
  getSnapshot(conversationId: number, opts?: { includeScenario?: boolean }): Promise<any>;
  postMessage(...): Promise<{ seq: number; turn: number; event: number }>;
  postTrace(...): Promise<{ seq: number; turn: number; event: number }>;
  claimTurn(...): Promise<{ ok: boolean; reason?: string }>;
  now(): number;
}

export interface IAgentEvents {
  subscribe(listener: (ev: StreamEvent) => void): () => void; // returns unsubscribe
}
```

---

## 2. **Implement the new `BaseAgent`**  

Create `src/agents/runtime/base-agent2.ts` (we’ll rename base‑agent.ts at the end):

```ts
import type { IAgentTransport, IAgentEvents } from './runtime.interfaces';
import type { StreamEvent } from '$src/agents/clients/event-stream';
import type { GuidanceEvent } from '$src/types/orchestrator.types';
import type { UnifiedEvent } from '$src/types/event.types';

export interface TurnContext<TSnap = any> {
  conversationId: number;
  agentId: string;
  guidanceSeq: number;
  deadlineMs: number;
  snapshot: TSnap; // stable at turn start
  transport: IAgentTransport;
  getLatestSnapshot(): TSnap; // live mirror
}

export abstract class BaseAgent<TSnap = any> {
  private unsubscribe?: () => void;
  private liveSnapshot?: TSnap;
  private latestSeq = 0;

  constructor(
    private transport: IAgentTransport,
    private events: IAgentEvents
  ) {}

  async start(conversationId: number, agentId: string) {
    // Get live mirror initial state
    this.liveSnapshot = await this.transport.getSnapshot(conversationId, { includeScenario: true });
    this.latestSeq = this.maxSeq(this.liveSnapshot);

    // Subscribe
    this.unsubscribe = this.events.subscribe(async (ev) => {
      this.applyEvent(this.liveSnapshot, ev);

      if ((ev as GuidanceEvent).type === 'guidance') {
        const g = ev as GuidanceEvent;
        if (g.nextAgentId !== agentId) return;
        const claim = await this.transport.claimTurn(conversationId, agentId, g.seq);
        if (!claim.ok) return;

        const ctx: TurnContext<TSnap> = {
          conversationId,
          agentId,
          guidanceSeq: g.seq,
          deadlineMs: g.deadlineMs ? Date.now() + g.deadlineMs : Date.now() + 30000,
          snapshot: this.clone(this.liveSnapshot),
          transport: this.transport,
          getLatestSnapshot: () => this.clone(this.liveSnapshot),
        };
        await this.takeTurn(ctx);
      }
    });
  }

  stop() { this.unsubscribe?.(); }

  protected abstract takeTurn(ctx: TurnContext<TSnap>): Promise<void>;

  private applyEvent(snap: any, ev: StreamEvent) {
    if (!snap) return;
    if ('type' in ev && ev.type !== 'guidance') {
      snap.events = [...(snap.events ?? []), ev as UnifiedEvent];
      if (ev.type === 'message' && ev.finality === 'conversation') {
        snap.status = 'completed';
      }
    }
  }

  private clone<T>(obj: T): T { return JSON.parse(JSON.stringify(obj)); }
  private maxSeq(snap: any) { return snap?.events?.length ? Math.max(...snap.events.map((e: any) => e.seq || 0)) : 0; }
}
```

---

## 3. **Create concrete transports and event adapters**

### Internal

`src/agents/runtime/inprocess.transport.ts`:

```ts
export class InProcessTransport implements IAgentTransport {
  constructor(private orch: OrchestratorService) {}
  getSnapshot(id, opts) {
    return opts?.includeScenario
      ? this.orch.getHydratedConversationSnapshot(id)
      : this.orch.getConversationSnapshot(id);
  }
  postMessage(...args) { return this.orch.sendMessage(...args); }
  postTrace(...args) { return this.orch.sendTrace(...args); }
  claimTurn(...args) { return this.orch.claimTurn(...args); }
  now() { return Date.now(); }
}
```

`src/agents/runtime/inprocess.events.ts`:

```ts
export class InProcessEvents implements IAgentEvents {
  constructor(private orch: OrchestratorService, private conversationId: number, private includeGuidance = true) {}
  subscribe(listener) {
    const subId = this.orch.subscribe(this.conversationId, listener, this.includeGuidance);
    return () => this.orch.unsubscribe(subId);
  }
}
```

### External (WS)

Wrap `WsEventStream`:

```ts
export class WsAgentEvents implements IAgentEvents {
  constructor(private wsUrl: string, private subParams: any) {}
  subscribe(listener) {
    const stream = new WsEventStream(this.wsUrl, this.subParams);
    let stopped = false;
    (async () => {
      for await (const ev of stream) {
        if (stopped) break;
        listener(ev);
      }
    })();
    return () => { stopped = true; stream.close(); };
  }
}
```

External `IAgentTransport` wraps `WsAgentClient` for message/trace/claim, plus a `getSnapshot` call over JSON‑RPC.

---

## 4. **Refactor all existing agents**

Every `Agent` class now:

- Extends `BaseAgent`
- Implements `takeTurn(ctx)` signature
- Drops their own subscription/claim logic

Example: **EchoAgent**:

```ts
export class EchoAgent extends BaseAgent {
  protected async takeTurn(ctx: TurnContext) {
    await ctx.transport.postMessage({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      text: 'Hello',
      finality: 'turn'
    });
  }
}
```

---

## 5. **Remove executors**

Delete:

- `TurnLoopExecutorInternal`
- `TurnLoopExecutorExternal`

Update any `startScenarioAgents` or CLI scripts that constructed them. Instead, construct the agent subclass with the correct `transport` and `events`, then call `.start()`:

```ts
const agent = new EchoAgent(
  new InProcessTransport(orchestrator),
  new InProcessEvents(orchestrator, conversationId)
);
agent.start(conversationId, 'agent-alpha');
```

---

## 6. **Update factories**

`startScenarioAgents` simplifies dramatically:

- No more loop objects — just hold on to the agent instances returned for stop().
- Instantiate correct `transport`+`events` for each `internal` agent, based on orchestrator (in-process) or remote (WS).

---

## 7. **Update tests**

Where tests used to:

```ts
const exec = new TurnLoopExecutorInternal(orch, { ... });
await exec.start();
```

…change to:

```ts
const agent = new TestAgent(new InProcessTransport(orch), new InProcessEvents(orch, convoId, true));
agent.start(convoId, 'agent-id');
// … then trigger guidance via orch.appendEvent(...)
```

If you need to simulate remote WS, wrap test orchestrator in a fake `IAgentEvents` that calls listener immediately.

---

## 8. **Advantages for tests with `BaseAgent`**

- You can manually `.subscribe()` to orchestrator in tests to feed events into `BaseAgent` without actually spinning up the orchestration loop.
- You can inspect `agent.getLatestSnapshot()` inside `takeTurn()` to assert catch-up works.

---

## 9. **End-to-End scenarios**

Verify:

1. Internal agent launches with in-process adapters, receives guidance, claims turn, runs `takeTurn()`.
2. External agent launches with WS adapters, same behaviour.
3. Live snapshot updates across multiple events (simulate other agents posting in between).
4. End-of-conversation events cause snapshot’s status to update and processing to stop.

---

## 10. **Remove unused**

Once migrated:

- Delete the old executors.
- Delete `InProcessEventStream`/`WsEventStream` *if* not used anywhere else except inside the new event adapters. Or keep them for implementations of `IAgentEvents` only.
- Remove any tests specifically for old executor classes.

---

### Example: Running Internal Echo in CLI after refactor

```ts
const orch = app.orchestrator;
const convoId = orch.createConversation({ agents: [{ id: 'alpha', kind: 'internal' }, { id: 'beta', kind: 'internal' }] });
const agent = new EchoAgent(
  new InProcessTransport(orch),
  new InProcessEvents(orch, convoId, true)
);
agent.start(convoId, 'alpha');
```

---

**Deliverable**: After this change, *all* agents (scenario-driven, assistant, echo, test) share one runtime loop in `BaseAgent`. Internal vs external differences are entirely in small adapter classes for transport and events.

Do you want me to also **prepare the git‑level checklist** of files to remove/modify so the developer has a “diff shopping list” to follow? That’s often helpful for a rip‑and‑replace.


Alright — here’s the **shopping list / change checklist** so the assigned developer can walk through the refactor without missing anything.

---

# 🛒 **Rip‑and‑Replace Executor → BaseAgent Migration Checklist**

> **Goal:** Remove `TurnLoopExecutorInternal` / `TurnLoopExecutorExternal` and their duplication. Replace with new `BaseAgent` + thin transport/event adapters. Update all agents, factories, CLIs, and tests accordingly.

---

## **1 — New Runtime Interfaces & BaseAgent**

**ADD** new files:

```
src/agents/runtime/runtime.interfaces.ts
```
- `IAgentTransport` / `IAgentEvents` interfaces.

```
src/agents/runtime/base-agent2.ts`  (or overwrite `base-agent.ts` if possible)
```
- Contains the unified `BaseAgent` (with stable + `getLatestSnapshot()` support, subscription, turn claiming, live snapshot merging).

---

## **2 — New Adapters**

**ADD**:

```
src/agents/runtime/inprocess.transport.ts
```
- Implements `IAgentTransport` → wraps `OrchestratorService`.

```
src/agents/runtime/inprocess.events.ts
```
- Implements `IAgentEvents` → wraps Orchestrator `.subscribe()`.

```
src/agents/runtime/ws.transport.ts
```
- Wraps `WsAgentClient` to implement `IAgentTransport` (including `getSnapshot` via RPC).

```
src/agents/runtime/ws.events.ts
```
- Wraps `WsEventStream` to implement `IAgentEvents` (subscribe/unsubscribe, feed listener).

---

## **3 — Delete Old Executors**

**DELETE**:

```
src/agents/executors/turn-loop-executor.internal.ts
src/agents/executors/turn-loop-executor.external.ts
```

…and their dedicated tests:

```
src/agents/executors/turn-coordination.test.ts
```
(Will need to re‑implement key behaviours in new BaseAgent tests)

---

## **4 — Update Agents**

For each:

```
src/agents/echo.agent.ts
src/agents/assistant.agent.ts
src/agents/scenario/scenario-driven.agent.ts
src/agents/test-agent.ts
src/agents/script/script.agent.ts
```

- Change class to `extends BaseAgent<TheirSnapshotType>`.
- Implement `protected async takeTurn(ctx: TurnContext)` instead of `handleTurn()`.
- Remove manual snapshot fetching/subscriptions — now use `ctx.snapshot` (stable view) and `ctx.getLatestSnapshot()` when fresh state needed.
- Access orchestrator via `ctx.transport`.

---

## **5 — Update Factories**

- `src/agents/factories/internal-agent.factory.ts`
- `src/agents/factories/scenario-agent.factory.ts`

Replace any construction of `TurnLoopExecutorInternal` / `External` with:

```ts
const agent = new ScenarioDrivenAgent(
  new InProcessTransport(orchestrator),
  new InProcessEvents(orchestrator, conversationId, true)
);
agent.start(conversationId, agentId);
// keep a reference if you need to .stop() later
```

For WS‑driven external agents:

```ts
const agent = new EchoAgent(
  new WsTransport(wsUrl),
  new WsEvents(wsUrl, { conversationId, includeGuidance: true })
);
agent.start(conversationId, agentId);
```

---

## **6 — Update CLI Scripts**

- `src/cli/run-agent-base-external.ts`
- `src/cli/run-agent-base-internal.ts`
- Any CLI that currently spins up `TurnLoopExecutor*` → switch to directly constructing agents with adapters.

---

## **7 — Update/Replace Tests**

**Remove** old executor‑centric tests:

```
src/agents/executors/turn-coordination.test.ts
```

**Add** new tests for `BaseAgent` in:

```
src/agents/runtime/base-agent.test.ts
```

Test cases:
- starts on guidance for me, claims, calls `takeTurn()`.
- doesn’t run turn when guidance for other agent.
- live snapshot (`getLatestSnapshot()`) updates on new events.
- stable snapshot in `ctx.snapshot` doesn’t mutate mid‑turn.
- unsubscribes on `stop()`.

**Update** agent‑specific tests (e.g., `assistant.agent.test.ts`, `scenario-driven.agent.test.ts`) to:
- Construct agent with `InProcessTransport` + `InProcessEvents` for in‑repo testing.
- Simulate orchestration by pushing guidance/events into orchestrator to drive turns.

---

## **8 — Update Orchestrator/Transport Code for Snapshots**

- Ensure orchestrator has a method to getConversationSnapshot **and** getHydratedConversationSnapshot; the difference is just `includeScenario` flag.
- WS transport: add an RPC for `getConversationSnapshot` with `includeScenario`.

---

## **9 — Remove Unused Streams (optional)**

If `InProcessEventStream` / `WsEventStream` are only used for old executors:
- You can inline them into the WS/IPC `IAgentEvents` adapters and remove exports.

---

## **10 — Verify End-to-End**

Test matrix:

| Agent Type         | Context   | Transport/Event Adapter               |
|--------------------|-----------|---------------------------------------|
| EchoAgent           | Internal  | InProcessTransport / InProcessEvents  |
| EchoAgent           | External  | WsTransport / WsEvents                |
| ScenarioDrivenAgent | Internal  | InProcessTransport / InProcessEvents  |
| ScenarioDrivenAgent | External? | WsTransport / WsEvents                |
| AssistantAgent      | Internal  | InProcessTransport / InProcessEvents  |

---

## **Example Final Run Startup**

**Internal run from CLI:**
```ts
const agent = new EchoAgent(
  new InProcessTransport(app.orchestrator),
  new InProcessEvents(app.orchestrator, convoId, true)
);
agent.start(convoId, 'agent-alfa');
```

**External/WS run from CLI:**
```ts
const agent = new ScenarioDrivenAgent(
  new WsTransport(wsUrl),
  new WsEvents(wsUrl, { conversationId: convoId, includeGuidance: true })
);
agent.start(convoId, 'agent-beta');
```

---

Would you like me to also deliver a sample **before/after diff** for one specific agent (say, `EchoAgent`) so the developer immediately sees the concrete code changes they’ll need to do in each agent class? That will speed up the repetitive part.

Perfect — let’s make a **before/after diff** for one concrete agent (`EchoAgent`) so the dev sees exactly how the refactor works in practice.

We’ll go from the *current* executor‑based style to the **new** `BaseAgent` + adapters style.

---

## 📂 File: `src/agents/echo.agent.ts`

### **BEFORE** (today)
```ts
import type { Agent, AgentContext } from '$src/agents/agent.types';
import { logLine } from '$src/lib/utils/logger';

export class EchoAgent implements Agent {
  constructor(
    private progressText = 'Processing...', 
    private finalText = 'Done'
  ) {}

  async handleTurn(ctx: AgentContext): Promise<void> {
    const t0 = Date.now();
    logLine(ctx.agentId, 'turn start', `echo agent`);
    
    const r1 = await ctx.client.postMessage({ 
      conversationId: ctx.conversationId, 
      agentId: ctx.agentId, 
      text: this.progressText, 
      finality: 'none' 
    });
    logLine(ctx.agentId, 'posted progress', `seq=${r1.seq}`, `${Date.now() - t0}ms`);
    
    const r2 = await ctx.client.postMessage({ 
      conversationId: ctx.conversationId, 
      agentId: ctx.agentId, 
      text: this.finalText, 
      finality: 'turn' 
    });
    logLine(ctx.agentId, 'posted final', `seq=${r2.seq}`, `${Date.now() - t0}ms`);
  }
}
```

⟶ This `EchoAgent` only defines `handleTurn(ctx)` and **relies on an executor** to:
- subscribe to guidance
- claim turn
- pass in `AgentContext` with `.client`

---

### **AFTER** (new `BaseAgent` model)
```ts
import { BaseAgent, TurnContext } from '$src/agents/runtime/base-agent2';
import { logLine } from '$src/lib/utils/logger';

export class EchoAgent extends BaseAgent {
  constructor(
    transport, // IAgentTransport
    events,    // IAgentEvents
    private progressText = 'Processing...',
    private finalText = 'Done'
  ) {
    super(transport, events);
  }

  protected async takeTurn(ctx: TurnContext): Promise<void> {
    const t0 = Date.now();
    logLine(ctx.agentId, 'turn start', `echo agent`);

    await ctx.transport.postMessage({ 
      conversationId: ctx.conversationId, 
      agentId: ctx.agentId, 
      text: this.progressText, 
      finality: 'none' 
    });

    await ctx.transport.postMessage({ 
      conversationId: ctx.conversationId, 
      agentId: ctx.agentId, 
      text: this.finalText, 
      finality: 'turn' 
    });

    logLine(ctx.agentId, 'turn complete', '', `${Date.now() - t0}ms`);
  }
}
```

🔹 **Changes & Benefits:**
- `EchoAgent` now **extends** `BaseAgent` instead of `implements Agent`.
- All loop logic (subscribe, claim turn, snapshot handling) is gone — handled by `BaseAgent`.
- Uses `ctx.transport.postMessage()` instead of `ctx.client`.
- Can call `ctx.getLatestSnapshot()` inside `takeTurn()` if it ever needs the freshest view mid‑turn.

---

## 📂 Example: starting the agent

Instead of old executor:

```ts
const exec = new TurnLoopExecutorInternal(orch, { ... });
exec.start();
```

**Now**:

```ts
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import { InProcessEvents } from '$src/agents/runtime/inprocess.events';

const agent = new EchoAgent(
  new InProcessTransport(orchestrator),
  new InProcessEvents(orchestrator, conversationId, true)
);
agent.start(conversationId, 'agent-alpha');
```

…or WS‑based external:

```ts
import { WsTransport } from '$src/agents/runtime/ws.transport';
import { WsAgentEvents } from '$src/agents/runtime/ws.events';

const agent = new EchoAgent(
  new WsTransport(wsUrl),
  new WsAgentEvents(wsUrl, { conversationId, includeGuidance: true })
);
agent.start(conversationId, 'agent-alpha');
```

---

## 📂 Test impact

Old test:

```ts
const ctx = { /* fake AgentContext */ };
await agent.handleTurn(ctx);
```

New test:

```ts
const transport = new FakeTransport();
const events = new FakeEvents();
const agent = new EchoAgent(transport, events);

// Simulate startup
await agent.start(1, 'agent-alpha');

// Simulate incoming guidance for me
events.emit({ type: 'guidance', conversation: 1, seq: 42, nextAgentId: 'agent-alpha' });

// Verify transport.postMessage was called twice
```

---

## 🔹 Pattern for ALL agents

- **AssistantAgent**, **ScenarioDrivenAgent**, **TestAgent**, etc. follow the same change:
  - Extend `BaseAgent<SnapshotType>`
  - Move `handleTurn()` → `protected async takeTurn(ctx: TurnContext<SnapshotType>)`
  - Use `ctx.transport` + `ctx.snapshot` + `ctx.getLatestSnapshot()`.

---

If you like, I can produce a **batch diff** mapping for all 4–5 core agents in your repo, so it’s mostly search‑and‑replace for the teammate.  
Want me to do that “multi‑agent before/after map” next? That would pair with the checklist and let them knock this out in one sweep.

Alright — here’s the **multi‑agent before/after refactor map** for your core agents.  
This is meant as a **pattern template** so the developer can systematically update *every* agent in one sweep.

---

## 0️⃣ Refactor Pattern Recap

For *all* agents:

- **Before:**  
  - `implements Agent` or uses `handleTurn(ctx)` with an `AgentContext` provided by `TurnLoopExecutor*`
  - No `start()` — entirely driven by executor
- **After:**
  - `extends BaseAgent<SnapshotType>`
  - Implement `protected async takeTurn(ctx: TurnContext<SnapshotType>)`
  - Use `ctx.transport` to post/trace/claim, `ctx.snapshot` for stable turn data
  - `ctx.getLatestSnapshot()` is available if they need fresh state mid‑turn
  - Constructor takes `(transport: IAgentTransport, events: IAgentEvents, ...agentSpecificArgs)`, calls `super(transport, events)`

---

## 1️⃣ **EchoAgent**

### BEFORE
```ts
export class EchoAgent implements Agent {
  async handleTurn(ctx: AgentContext) {
    await ctx.client.postMessage({ conversationId: ctx.conversationId, ... });
    await ctx.client.postMessage({ conversationId: ctx.conversationId, ... });
  }
}
```

### AFTER
```ts
export class EchoAgent extends BaseAgent {
  constructor(transport, events, private msg1='Processing...', private msg2='Done') {
    super(transport, events);
  }
  protected async takeTurn(ctx: TurnContext) {
    await ctx.transport.postMessage({ conversationId: ctx.conversationId, text: this.msg1, finality: 'none' });
    await ctx.transport.postMessage({ conversationId: ctx.conversationId, text: this.msg2, finality: 'turn' });
  }
}
```

---

## 2️⃣ **AssistantAgent**

Snapshot type is likely `HydratedConversationSnapshot` (LLM prompt needs scenario & history).

### BEFORE
```ts
export class AssistantAgent implements Agent {
  constructor(private llm: LLMClient) {}
  async handleTurn(ctx: AgentContext<HydratedConversationSnapshot>) {
    const reply = await this.llm.complete({ prompt: buildPrompt(ctx.snapshot) });
    await ctx.client.postMessage({ conversationId: ctx.conversationId, text: reply, finality: 'turn' });
  }
}
```

### AFTER
```ts
export class AssistantAgent extends BaseAgent<HydratedConversationSnapshot> {
  constructor(transport, events, private llm: LLMClient) {
    super(transport, events);
  }
  protected async takeTurn(ctx: TurnContext<HydratedConversationSnapshot>) {
    const reply = await this.llm.complete({ prompt: buildPrompt(ctx.snapshot) });
    await ctx.transport.postMessage({ conversationId: ctx.conversationId, agentId: ctx.agentId, text: reply, finality: 'turn' });
  }
}
```

---

## 3️⃣ **ScenarioDrivenAgent**

Likely uses scenario metadata inside snapshot.

### BEFORE
```ts
export class ScenarioDrivenAgent implements Agent {
  constructor(private scenarioLogic: ScenarioLogic) {}
  async handleTurn(ctx: AgentContext<HydratedConversationSnapshot>) {
    const action = this.scenarioLogic.decide(ctx.snapshot);
    await ctx.client.postMessage({ conversationId: ctx.conversationId, ...action });
  }
}
```

### AFTER
```ts
export class ScenarioDrivenAgent extends BaseAgent<HydratedConversationSnapshot> {
  constructor(transport, events, private scenarioLogic: ScenarioLogic) {
    super(transport, events);
  }
  protected async takeTurn(ctx: TurnContext<HydratedConversationSnapshot>) {
    const action = this.scenarioLogic.decide(ctx.snapshot);
    await ctx.transport.postMessage({ conversationId: ctx.conversationId, agentId: ctx.agentId, ...action });
  }
}
```

---

## 4️⃣ **TestAgent** (mock agent for testing orchestration)

### BEFORE
```ts
export class TestAgent implements Agent {
  async handleTurn(ctx: AgentContext) {
    ctx.client.postTrace({ payload: { seenSeq: ctx.snapshot.events.map(e=>e.seq) }});
  }
}
```

### AFTER
```ts
export class TestAgent extends BaseAgent {
  constructor(transport, events) {
    super(transport, events);
  }
  protected async takeTurn(ctx: TurnContext) {
    await ctx.transport.postTrace({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      payload: { seenSeq: ctx.snapshot.events.map(e=>e.seq) }
    });
  }
}
```

---

## 5️⃣ **ScriptAgent** (runs pre‑scripted messages)

### BEFORE
```ts
export class ScriptAgent implements Agent {
  constructor(private script: string[]) {}
  async handleTurn(ctx: AgentContext) {
    for (const line of this.script) {
      await ctx.client.postMessage({ conversationId: ctx.conversationId, text: line, finality: 'none' });
    }
    await ctx.client.postMessage({ conversationId: ctx.conversationId, text: 'End', finality: 'turn' });
  }
}
```

### AFTER
```ts
export class ScriptAgent extends BaseAgent {
  constructor(transport, events, private script: string[]) {
    super(transport, events);
  }
  protected async takeTurn(ctx: TurnContext) {
    for (const line of this.script) {
      await ctx.transport.postMessage({ conversationId: ctx.conversationId, agentId: ctx.agentId, text: line, finality: 'none' });
    }
    await ctx.transport.postMessage({ conversationId: ctx.conversationId, agentId: ctx.agentId, text: 'End', finality: 'turn' });
  }
}
```

---

## 🔹 Startup Patterns After Refactor

**Internal agent factory call:**
```ts
const agent = new EchoAgent(
  new InProcessTransport(orch),
  new InProcessEvents(orch, convoId, true)
);
agent.start(convoId, 'agent-alpha');
```

**WS/External factory call:**
```ts
const agent = new AssistantAgent(
  new WsTransport(wsUrl),
  new WsAgentEvents(wsUrl, { conversationId: convoId, includeGuidance: true }),
  llmClient
);
agent.start(convoId, 'agent-beta');
```

---

## 🧾 Migration Steps Per Agent File

1. Change `implements Agent` → `extends BaseAgent<SnapshotType?>`
2. Remove old `handleTurn(ctx: AgentContext)`  
   Replace with `protected async takeTurn(ctx: TurnContext<SnapshotType>)`
3. Change `ctx.client` calls → `ctx.transport` calls
4. Remove explicit snapshot fetching — use `ctx.snapshot`
5. Keep any scenario/LLM logic unchanged — just feed it `ctx.snapshot`
6. Wire through any dependencies (scenarioLogic, llmClient, scripts) via constructor; call `super(transport, events)` at the top of constructor.

---

If you like, I can now produce a **diff chunk** for *each* of these agents so your dev can apply them with search/replace fairly quickly.  
Do you want me to prepare it in unified diff format so they can literally patch it in?

