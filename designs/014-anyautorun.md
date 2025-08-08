Got it ✅ – I’ll give you a **self‑contained, cleaned‑up dev plan** for moving to a **StrictAlternationPolicy** and **stateless, per‑turn agent instantiation**, **without any of the old SimpleAlternationPolicy cruft**.  

This will give you:

1. A single scheduling policy (`StrictAlternationPolicy`) for both internal↔internal and internal↔external cases.
2. `startInternalAgents()` that **does not** create agent instances up front — instead, each loop turn will `new` an agent on demand from metadata.
3. Removal of `SimpleAlternationPolicy` and any unused scenario‑only startup code.
4. Minimal dependencies — just the orchestrator, loops, and a small metadata→agent factory function.
5. Conversation startup remains clean and simple.

---

## 📜 Updated Dev Plan — Strict Alternation + Stateless Per‑Turn Agents

---

### 🎯 Goals

- **Unify scheduling** under one strict alternation policy: only switch turns at `finality: 'turn'` or `'conversation'` events.
- **Support any kind of internal agent** (scenario, assistant, echo etc.) — not hard‑coded for scenarios.
- **Eliminate** the old `SimpleAlternationPolicy` completely to avoid policy cruft.
- **Instantiate agents per turn**, based on conversation snapshot metadata.
- Keep loops totally **stateless** outside of the conversation log.

---

## 1️⃣ Implement `StrictAlternationPolicy`

```ts
export class StrictAlternationPolicy implements SchedulePolicy {
  decide({ snapshot, lastEvent }: SchedulePolicyInput): ScheduleDecision {
    // Only switch on message events that end a turn or conversation
    if (!lastEvent ||
        lastEvent.type !== 'message' ||
        (lastEvent.finality !== 'turn' && lastEvent.finality !== 'conversation')) {
      return { kind: 'none' };
    }

    const agents = snapshot.metadata.agents.map(a => a.id);
    if (agents.length < 2) return { kind: 'none' };

    const currentIdx = agents.indexOf(lastEvent.agentId);
    if (currentIdx === -1) return { kind: 'none' };

    const nextIdx = (currentIdx + 1) % agents.length;
    const nextId = agents[nextIdx];
    const nextMeta = snapshot.metadata.agents.find(a => a.id === nextId)!;

    if (nextMeta.kind === 'internal') {
      return { kind: 'internal', agentId: nextId };
    } else {
      return { kind: 'external', candidates: [nextId], note: `Waiting for ${nextId}` };
    }
  }
}
```

☑ No reaction to `claim_expired`.  
☑ Works for any number of agents.  
☑ Same logic for internal↔internal and internal↔external.

---

## 2️⃣ Delete `SimpleAlternationPolicy`

- Remove the `SimpleAlternationPolicy` file/class entirely.
- Remove any imports and references to it.
- Replace these with `StrictAlternationPolicy` in orchestrator setup.

---

## 3️⃣ Stateless Per‑Turn Agent Instantiation

The agent interface:

```ts
export interface Agent {
  handleTurn(ctx: AgentContext): Promise<void>;
}

export interface AgentContext {
  conversationId: number;
  agentId: string;
  deadlineMs: number;
  client: IAgentClient;
  logger: Logger;
}
```

This is **pure** — all input comes in via `ctx`.  
Therefore: no need to keep an agent object alive between turns.

---

### Implementation Pattern

#### Agent builder

A simple function to map `AgentMetadata` to a new instance:

```ts
function buildAgent(meta: AgentMetadata): Agent {
  switch (meta.role) {
    case 'scenario':
      return new ScenarioDrivenAgent(loadScenario(meta.scenarioId));
    case 'assistant':
      return new AssistantAgent(globalLLMConfig);
    case 'echo':
      return new EchoAgent();
    default:
      throw new Error(`Unknown agent role: ${meta.role}`);
  }
}
```

---

#### update `TurnLoopExecutorInternal`

Instead of holding a persistent `agentImpl`, hold a reference to:

```ts
(conversationId: string, meta: AgentMetadata) => Agent
```

Every time this loop is told to run a turn, it does:

```ts
const agent = this.buildAgent(this.meta);
await agent.handleTurn(ctx);
```

→ The instance is discarded immediately after the turn finishes.

---

## 4️⃣ New `startInternalAgents()` (stateless edition)

```ts
export async function startInternalAgents({
  orchestrator,
  conversationId,
  logger,
}: {
  orchestrator: OrchestratorService;
  conversationId: string;
  logger: Logger;
}) {
  const snapshot = await orchestrator.getConversationSnapshot(conversationId);
  const loops: TurnLoopExecutorInternal[] = [];

  for (const meta of snapshot.metadata.agents) {
    if (meta.kind !== 'internal') continue;

    const loop = new TurnLoopExecutorInternal({
      conversationId,
      agentId: meta.id,
      meta,
      orchestrator,
      buildAgent,
      logger: logger.child({ agent: meta.id }),
    });

    void loop.start();
    loops.push(loop);
  }

  return {
    loops,
    stop: async () => {
      for (const loop of loops) loop.stop();
    }
  };
}
```

---

## 5️⃣ Orchestrator Setup

```ts
const policy = new StrictAlternationPolicy();
const orchestrator = new OrchestratorService(storage, bus, policy, cfg);

const { stop } = await startInternalAgents({
  orchestrator,
  conversationId,
  logger
});
```

---

## 🔄 Flow by Scenario

**Case A**: 2 internal agents
```
INT‑A ends → schedule INT‑B
INT‑B ends → schedule INT‑A
... repeat ...
```

**Case B**: internal + external
```
EXT ends → schedule INT → loop turn → output
INT ends → schedule EXT → wait indefinitely
```

---

## 6️⃣ Cleanup Checklist

- Delete `SimpleAlternationPolicy` and any callsites.
- Delete scenario‑specific `startScenarioAgents()`; replace usage with `startInternalAgents()`.
- Ensure orchestrator always gets `StrictAlternationPolicy`.
- Audit for any leftover references to removed classes/methods.

---

## ✅ End State

- **One** clear scheduling policy file.
- **No old alternation logic** lurking in codebase.
- **No registries** or long‑lived internal agent instances — instances are created per turn.
- **startInternalAgents** is generic, works on any internal agent type.
- Completely stateless design between turns; state is always in conversation events.

---

If you want, I can follow this up with the **exact `TurnLoopExecutorInternal` change** to accept a `buildAgent` function instead of an agent instance — so no one has to guess how to hook this in.  

Do you want me to include that code next?
Alright — here’s the **updated, self‑contained** `TurnLoopExecutorInternal` that works with the **build‑agent‑per‑turn** model we just planned out.  
This is the drop‑in replacement for the old “hold one agent instance forever” version.  

---

## Updated `TurnLoopExecutorInternal`

```ts
type BuildAgentFn = (meta: AgentMetadata) => Agent;

interface TurnLoopExecutorInternalOptions {
  conversationId: number;
  agentId: string;
  meta: AgentMetadata;
  orchestrator: OrchestratorService;
  buildAgent: BuildAgentFn;
  logger: Logger;
}

export class TurnLoopExecutorInternal {
  private running = false;
  private stopRequested = false;

  constructor(private opts: TurnLoopExecutorInternalOptions) {}

  async start() {
    this.running = true;
    this.opts.logger.info(`Internal agent loop starting`, {
      conversationId: this.opts.conversationId,
      agentId: this.opts.agentId,
    });

    while (!this.stopRequested) {
      try {
        // Wait until orchestrator says it's this agent's turn
        const turnCtx = await this.opts.orchestrator.waitForTurn(
          this.opts.conversationId,
          this.opts.agentId
        );
        if (!turnCtx) {
          // Orchestrator ended conversation or we were stopped
          break;
        }

        // Build a brand new agent instance **for this turn**
        const agent = this.opts.buildAgent(this.opts.meta);

        // Construct AgentContext and run one turn
        await agent.handleTurn({
          conversationId: this.opts.conversationId,
          agentId: this.opts.agentId,
          deadlineMs: turnCtx.deadlineMs,
          client: this.opts.orchestrator.getAgentClient(),
          logger: this.opts.logger,
        });

        // Loop again until stop requested or conversation ends
      } catch (err) {
        this.opts.logger.error(`Error in agent loop: ${(err as Error).stack || err}`);
        // Prevent hot loop in error case by adding a short delay
        await new Promise((res) => setTimeout(res, 500));
      }
    }

    this.opts.logger.info(`Internal agent loop stopped`, {
      conversationId: this.opts.conversationId,
      agentId: this.opts.agentId,
    });
    this.running = false;
  }

  stop() {
    this.stopRequested = true;
  }
}
```

---

## Key Differences from “old” version

1. **Takes `buildAgent` fn** in options, not a pre‑built instance.
2. **Per turn**:
    - Calls `buildAgent(meta)` to get a fresh `Agent`.
    - Immediately `handleTurn(ctx)`.
    - Discards the instance after the turn completes.
3. All per‑turn state is inside `AgentContext` and the conversation log, not in memory between turns.
4. `meta` is passed through unchanged each turn so builders can use `scenarioId`, `role`, etc.
5. Still supports graceful stop by setting `stopRequested`.

---

## How This Works in the New Plan

From our updated `startInternalAgents()`:

```ts
const loop = new TurnLoopExecutorInternal({
  conversationId,
  agentId: meta.id,
  meta,
  orchestrator,
  buildAgent,
  logger: logger.child({ agent: meta.id }),
});
void loop.start();
```

The `buildAgent` here is the global stateless mapping:

```ts
function buildAgent(meta: AgentMetadata): Agent {
  switch (meta.role) {
    case 'scenario':
      return new ScenarioDrivenAgent(loadScenario(meta.scenarioId));
    case 'assistant':
      return new AssistantAgent(globalLLMConfig);
    case 'echo':
      return new EchoAgent();
    default:
      throw new Error(`Unknown agent role: ${meta.role}`);
  }
}
```

---

## Advantages

- **True “heapless” agent lifecycle** — only in memory during turn execution.
- **No memory leaks** — once turn is complete, instance is gone.
- **Full compatibility** with your `Agent` interface — context contains all needed info each turn.
- **Flexible** — swapping `buildAgent` allows you to plug in any implementation without touching executor code.

---

If you want, I can also give you the **new orchestrator/waitForTurn** contract so it’s clear where this executor gets its “it’s your turn now” signal in the strict alternation world.  

Do you want me to include that piece so the integration is fully obvious end‑to‑end?
Alright — let’s close the loop completely and show how **`TurnLoopExecutorInternal`** talks to the **orchestrator** under the new  
**StrictAlternationPolicy** → *“it’s your turn now”* signal flow.  

That way it’s crystal‑clear where `waitForTurn()` fits in the control path.

---

## 1️⃣ Orchestrator / `waitForTurn()` Contract

The **orchestrator** owns:

- The active `SchedulePolicy` (now: `StrictAlternationPolicy`).
- The conversation event stream (from storage or message bus).
- The responsibility to resolve *when* each agent should act.

**The executor’s standpoint:**  
> “Tell me when it’s my agent’s turn in this conversation, and give me the deadline.”

So in the orchestrator we want:

```ts
// Pseudocode-ish — adjust to your actual orchestrator/service pattern
async waitForTurn(conversationId: number, agentId: string): Promise<{ deadlineMs: number } | null> {
  for await (const event of this.bus.subscribe(conversationId)) {
    const snapshot = await this.getConversationSnapshot(conversationId);
    const decision = this.policy.decide({ 
      snapshot, 
      lastEvent: event 
    });

    if (decision.kind === 'internal' && decision.agentId === agentId) {
      // The scheduler has decided it's this agent's turn
      const deadlineMs = this.computeDeadline(conversationId, agentId);
      return { deadlineMs };
    }

    if (snapshot.conversation.status === 'completed') {
      return null; // No more turns ever; end the loop
    }
  }
  return null; // Bus closed or orchestrator shutting down
}
```

---

### Key logic here:

- **StrictAlternationPolicy** decides `kind` and `agentId` based on the latest event.
- Returns immediately when it’s `kind: 'internal'` and matches the loop’s `agentId`.
- Provides `deadlineMs` to help agents respect time limits.
- Returns `null` if the conversation is completed/closed — tells loop to exit.

---

## 2️⃣ How the Pieces Fit Together

```
Participant sends final turn message ──► Orchestrator receives event
                                          │
                                          ▼
                           StrictAlternationPolicy.decide(...)
                                          │
                        ┌─────────────────┴───────────────────┐
                        │ decision.kind: 'internal'            │
                        │ decision.agentId: 'agent-B'           │
                        └─────────────────┬───────────────────┘
                                          │
                                          ▼
                        waitForTurn(agent-B) resolves with { deadlineMs }
                                          │
                                          ▼
                       TurnLoopExecutorInternal(buildAgent)
                                          │
                    buildAgent(meta) → fresh Agent instance
                                          │
                        Agent.handleTurn(ctx)
                                          │
                            postMessage(...)
                                          │
                     Orchestrator receives → triggers next turn decision
```

---

## 3️⃣ Orchestrator API Summary

For **TurnLoopExecutorInternal**, the orchestrator must expose:

```ts
interface OrchestratorService {
  getConversationSnapshot(conversationId: number): Promise<ConversationSnapshot>;

  // Called by executor loops to await their turn
  waitForTurn(
    conversationId: number,
    agentId: string
  ): Promise<{ deadlineMs: number } | null>;

  // Gives an IAgentClient bound to correct back-end endpoints
  getAgentClient(): IAgentClient;
}
```

---

## 4️⃣ Why This Works Well with Per‑Turn Instantiation

- **Loop stays idle** until `waitForTurn` resolves — no busy polling.
- Agent is built *only at the moment its turn begins*.
- Snapshot → policy → loop happens *every time*, so it works exactly the same whether the neighbor is internal or external.
- When conversation completes, `waitForTurn` resolves `null` and executor stops.

---

## 5️⃣ End-to-End in the New Model

1. `startInternalAgents()` queries snapshot, starts a `TurnLoopExecutorInternal` for each internal agent.
2. Executors sit sleeping inside `waitForTurn()`.
3. External or internal agent posts a terminal (`finality: 'turn'`/`'conversation'`) message.
4. Orchestrator runs `StrictAlternationPolicy` → picks the *other* agent.
5. That agent’s loop has `waitForTurn` resolve; it builds a fresh instance and runs `handleTurn()`.
6. Finished turn sends a message → repeat.

---

Would you like me to bundle all these pieces — **StrictAlternationPolicy**,  
`startInternalAgents`, updated `TurnLoopExecutorInternal`, and orchestrator’s `waitForTurn` stub — into a **single self‑contained reference implementation** file so you have one copy‑paste starting point? That way the whole strict‑alternation stateless system is “one page of code.”
