# Technical Proposal (Revised): Ensure Agents Running — Minimal, Explicit, Location-Agnostic

## Goals

- Explicit control: Callers decide where each agent runs.
- One simple API: Works with server-run or client-run agents.
- No hidden auto-starts: Everything is explicit and opt-in.
- KISS: Keep semantics simple; correctness relies on CAS + idempotency.

## What Changes (vs today)

- Remove `kind: 'internal' | 'external'` from agent metadata. Location is not a property of the agent; it is a runtime choice at ensure time.
- Provide two simple paths to “ensure running” without any server-side registry:
  1) Server-run: Orchestrator starts server runners on request.
  2) Client-run: A client process runs its own loop; the server does not track it.

## Core API

### 1) Server-run Ensure

```ts
interface EnsureAgentsRunningOptions {
  conversationId: number;
  agentIds: string[];
  providerConfig?: unknown; // optional; used only when server runs the agent
}

// RPC (server): start/ensure server-run loops for the given agents
ensureAgentsRunning(opts: EnsureAgentsRunningOptions): Promise<{
  ensured: Array<{ agentId: string; status: 'running' | 'starting' }>;
}>;
```

- Idempotency expectation: Implementations should avoid spawning duplicate loops per `{conversationId, agentId}` within a single process (e.g., via internal single-flight in the agent runner module). No global registry is required by this API.
- Providers: If an agent needs LLMs on the server, pass minimal `providerConfig`; clients running agents own their own providers.

### 2) Client-run (self-ensure)

```ts
// No RPC required. Clients simply run their agent loop.
// They subscribe to guidance/events and act using CAS + idempotency.
```

Minimal client loop sketch:

```ts
const stream = createEventStream(wsUrl, { conversationId, includeGuidance: true });
for await (const ev of stream) {
  if (ev.type === 'guidance' && ev.nextAgentId === agentId) {
    const snap = await getConversation(conversationId);
    await sendMessage({
      conversationId,
      agentId,
      text: '...response...',
      finality: 'turn',
      clientRequestId: crypto.randomUUID(),
      // include CAS preconditions via the transport layer if applicable
    });
  }
}
```

### 3) Client-side Ensure Helper (with local persistence)

Provide a tiny client helper to match server ergonomics — pass `agentIds`, get back `ensured` and per-agent `handles.stop()`. It persists entries in `localStorage` so it auto-resumes after reload.

API (client):

```ts
type Finality = 'none' | 'turn' | 'conversation';

interface ClientEnsureOptions {
  conversationId: number;
  agentIds: string[];
  wsUrl?: string;              // derived by default
  storageKey?: string;         // default: '__client_agents__'
  onGuidance: (ctx: {
    conversationId: number;
    agentId: string;
    guidance: GuidanceEvent;
    sendMessage: (input: { conversationId: number; agentId: string; text: string; finality: Finality; clientRequestId?: string; turn?: number }) => Promise<any>;
    getConversation: () => Promise<any>;
  }) => Promise<void> | void;
}

interface ClientEnsureHandle { stop: () => void }

function ensureAgentsRunningClient(opts: ClientEnsureOptions): Promise<{
  ensured: Array<{ agentId: string }>;
  handles: Record<string, ClientEnsureHandle>;
}>;

function autoResumeAgents(options: {
  storageKey?: string;         // default: '__client_agents__'
  wsUrl?: string;              // optional override
  handlerFor: (agentId: string) => ClientEnsureOptions['onGuidance'];
  conversationIdFor: (agentId: string) => number;
}): void;
```

Semantics:
- Persists `{ conversationId, agentId, wsUrl }` per agent under `storageKey` when ensured; removes on `handle.stop()`.
- `autoResumeAgents` reads `storageKey` on boot and calls `ensureAgentsRunningClient` for each record.
- Correctness relies on CAS + `clientRequestId` inside your `onGuidance` implementation.

## Concurrency & Idempotency (KISS)

- Correctness relies on existing guarantees:
  - CAS preconditions when opening a new turn prevent races.
  - Per-message `clientRequestId` ensures append idempotency.
- Server-run implementations should be self-idempotent per agent (single-flight or internal guard), but this is an implementation detail, not part of the API.

## Provider Placement (Flexible)

- Providers can live on either side. The side that runs the agent owns provider setup.
- Server-run ensure may accept an optional `providerConfig` to construct providers locally. Client-run agents construct providers on the client and never send secrets to the server.

## Migration

- Remove `kind` from agent metadata; treat location as a runtime decision.
- Keep `startAgents` (or similar) as the low-level primitive behind server-run ensure.
- Update demos:
  - Server-run: call `ensureAgentsRunning`.
  - Client-run: use the client loop pattern above. No additional RPCs are required.
- Optional: retain existing auto-run resume for server-run agents behind a config flag; default remains explicit (no auto-start).

## Why This Is KISS

- No server-side registry or heartbeats required for correctness.
- Minimal API surface: just `ensureAgentsRunning` for server-run; client-run needs nothing new.
- Clear separation of concerns: server doesn’t pretend to manage client processes; clients self-manage.

## Open Questions (Deferred)

- Explicit stopping of server-run loops (versus ending on conversation finality). Can be added later as a separate minimal RPC if needed.
- Backoff/jitter for server-run spawn loops. Start with simple retries or manual re-ensure.
- Multi-instance servers (cluster) coordination. Out of scope for minimal.

## Implementation Notes (Guidance)

### Server-run `ensureAgentsRunning` (wraps your internal start function)

```ts
interface EnsureAgentsRunningOptions {
  conversationId: number;
  agentIds: string[];
  providerConfig?: unknown;
}

export async function ensureAgentsRunning(opts: EnsureAgentsRunningOptions) {
  const ensured: { agentId: string; status: 'running' | 'starting' }[] = [];
  // De-dupe locally to avoid obvious duplicates
  const ids = Array.from(new Set(opts.agentIds));
  for (const agentId of ids) {
    // startInternalAgent should guard against double-start within this process
    await startInternalAgent({ conversationId: opts.conversationId, agentId, providerConfig: opts.providerConfig });
    ensured.push({ agentId, status: 'running' });
  }
  return { ensured } as const;
}
```

### Client-run loop (no new RPCs)

```ts
const stream = createEventStream(wsUrl, { conversationId, includeGuidance: true });
for await (const ev of stream) {
  if (ev.type === 'guidance' && ev.nextAgentId === agentId) {
    const { lastClosedSeq } = await getConversation(conversationId);
    await sendMessage({
      conversationId,
      agentId,
      text: '...response...'
      , finality: 'turn',
      clientRequestId: crypto.randomUUID(),
      // transport includes CAS using lastClosedSeq if required
    });
  }
}
```

### Usage examples

- Server ensure (internal loops):
```ts
await rpc.call('ensureAgentsRunning', { conversationId, agentIds: ['alpha', 'beta'] });
```

- Client ensure with persistence + auto-resume:
```ts
autoResumeAgents({
  handlerFor: (agentId) => async ({ sendMessage, getConversation, conversationId }) => {
    const { lastClosedSeq } = await getConversation();
    await sendMessage({ conversationId, agentId, text: '...', finality: 'turn', clientRequestId: crypto.randomUUID() });
  },
  conversationIdFor: () => 42,
});

await ensureAgentsRunningClient({
  conversationId: 42,
  agentIds: ['you'],
  onGuidance: async ({ sendMessage, getConversation, conversationId, agentId }) => {
    const { lastClosedSeq } = await getConversation();
    await sendMessage({ conversationId, agentId, text: 'Hello', finality: 'turn', clientRequestId: crypto.randomUUID() });
  },
});
```
