Below is a complete, self-contained development plan and reference implementation outline to achieve two identical agents that can run:

- Externally in a separate CLI process, connecting to the server over WebSocket JSON-RPC (Bun-compatible, browser-style APIs).
- Internally in-process using direct orchestrator calls.

Key decisions incorporated
- Minimal Agent API: Agents only depend on `IAgentClient` via `AgentContext`. No duplicate helpers on the context. Optional ergonomics live in a separate `helpers` module.
- Identical agent classes (e.g., `EchoAgent`, `ScriptAgent`) used in both modes; only the client and executor differ.
- Bun-friendly clients: `WsJsonRpcClient` uses Bun’s global `WebSocket` and `fetch`, no Node-specific APIs.

Plan overview
- Stage A: Shared Agent API and core types (minimal).
- Stage B: Client implementations (in-process and WebSocket JSON-RPC).
- Stage C: Agents (Echo and Script).
- Stage D: Executors (internal one-shot, external loop).
- Stage E: CLI external simulation (two agents via WebSocket to a running server).
- Stage F: CLI internal simulation (two agents using the in-process client).
- Stage G: Tests (smoke/integration for both paths).
- Stage H: Next improvements (optional).

Stage A — Shared Agent API
Goals
- Define a minimal Agent programming model that depends only on `IAgentClient`.
- Ensure reusability in both in-process and WebSocket modes.

Files
- `src/agents/agent.types.ts`
- `src/agents/helpers.ts` (optional ergonomics)

Source
```ts
// src/agents/agent.types.ts
import type { TracePayload } from '$src/types/event.types';

export type TurnOutcome = 'posted' | 'yield' | 'no_action' | 'complete';

export interface Agent {
  handleTurn(ctx: AgentContext): Promise<TurnOutcome>;
}

export interface AgentContext {
  conversationId: number;
  agentId: string;
  deadlineMs: number;
  client: IAgentClient;
  logger: Logger;
}

export interface IAgentClient {
  // Reads
  getSnapshot(conversationId: number): Promise<{ conversation: number; status: 'active'|'completed'; events: any[] }>;
  getUpdatesOrGuidance(conversationId: number, sinceSeq?: number, limit?: number, timeoutMs?: number): Promise<{ latestSeq: number; status: 'active'|'completed'; messages: any[]; guidance: 'you_may_speak'|'wait'|'closed'|'unknown'; note?: string; timedOut: boolean }>;
  waitForChange(conversationId: number, sinceSeq: number, timeoutMs: number): Promise<{ latestSeq: number; timedOut: boolean }>;

  // Writes
  postMessage(params: { conversationId: number; agentId: string; text: string; finality: 'none'|'turn'|'conversation'; attachments?: Array<{ id?: string; docId?: string; name: string; contentType: string; content?: string; summary?: string }>; clientRequestId?: string; turnHint?: number }): Promise<{ seq: number; turn: number; event: number }>;
  postTrace(params: { conversationId: number; agentId: string; payload: TracePayload; turn?: number; clientRequestId?: string }): Promise<{ seq: number; turn: number; event: number }>;

  now(): Date;
}

export interface Logger {
  debug(msg: string, meta?: any): void;
  info(msg: string, meta?: any): void;
  warn(msg: string, meta?: any): void;
  error(msg: string, meta?: any): void;
}
```

```ts
// src/agents/helpers.ts
import type { AgentContext } from './agent.types';
import type { TracePayload } from '$src/types/event.types';

export async function post(ctx: AgentContext, text: string, finality: 'none'|'turn'|'conversation' = 'turn', attachments?: Array<{ id?: string; docId?: string; name: string; contentType: string; content?: string; summary?: string }>, clientRequestId?: string, turnHint?: number) {
  return ctx.client.postMessage({
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    text,
    finality,
    attachments,
    clientRequestId,
    turnHint,
  });
}

export async function postTrace(ctx: AgentContext, trace: TracePayload, turnHint?: number, clientRequestId?: string) {
  return ctx.client.postTrace({
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    payload: trace,
    turn: turnHint,
    clientRequestId,
  });
}

export async function getUpdates(ctx: AgentContext, sinceSeq?: number, limit?: number) {
  const res = await ctx.client.getUpdatesOrGuidance(ctx.conversationId, sinceSeq, limit, 0);
  return { latestSeq: res.latestSeq, status: res.status, messages: res.messages, guidance: res.guidance };
}
```

Stage B — Client implementations
Goals
- Implement `IAgentClient` for internal (in-process) and external (WebSocket JSON-RPC) use.
- Keep Bun/browser compatibility.

Files
- `src/agents/clients/inprocess.client.ts`
- `src/agents/clients/ws.client.ts`

Source
```ts
// src/agents/clients/inprocess.client.ts
import type { IAgentClient } from '$src/agents/agent.types';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { TracePayload, MessagePayload, UnifiedEvent } from '$src/types/event.types';

export class InProcessClient implements IAgentClient {
  constructor(private orch: OrchestratorService) {}

  async getSnapshot(conversationId: number) {
    return this.orch.getConversationSnapshot(conversationId);
  }

  async getUpdatesOrGuidance(conversationId: number, sinceSeq = 0, limit = 200, timeoutMs = 0) {
    const compute = () => {
      const snap = this.orch.getConversationSnapshot(conversationId);
      const msgs = snap.events.filter(e => e.type === 'message' && e.seq > sinceSeq).slice(0, limit);
      const latestSeq = snap.events.length ? snap.events[snap.events.length - 1]!.seq : sinceSeq;
      const g = computeGuidance(snap.events, snap.status);
      return { latestSeq, status: snap.status, messages: msgs, guidance: g.kind, note: g.note };
    };

    const immediate = compute();
    if (timeoutMs <= 0 || immediate.guidance === 'you_may_speak' || immediate.status === 'completed') {
      return { ...immediate, timedOut: false };
    }

    return await new Promise<typeof immediate & { timedOut: boolean }>((resolve) => {
      const subId = this.orch.subscribe(conversationId, (_e: UnifiedEvent) => {
        const state = compute();
        if (state.guidance === 'you_may_speak' || state.status === 'completed' || state.latestSeq > immediate.latestSeq) {
          cleanup();
          resolve({ ...state, timedOut: false });
        }
      });
      const to = setTimeout(() => {
        cleanup();
        const state = compute();
        resolve({ ...state, timedOut: true });
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(to);
        this.orch.unsubscribe(subId);
      };
    });
  }

  async waitForChange(conversationId: number, sinceSeq: number, timeoutMs: number) {
    const snap = this.orch.getConversationSnapshot(conversationId);
    const initialLatest = snap.events.length ? snap.events[snap.events.length - 1]!.seq : sinceSeq;
    if (initialLatest > sinceSeq) return { latestSeq: initialLatest, timedOut: false };

    return await new Promise<{ latestSeq: number; timedOut: boolean }>((resolve) => {
      const subId = this.orch.subscribe(conversationId, (_e: UnifiedEvent) => {
        const s = this.orch.getConversationSnapshot(conversationId);
        const latest = s.events.length ? s.events[s.events.length - 1]!.seq : sinceSeq;
        if (latest > sinceSeq) {
          cleanup();
          resolve({ latestSeq: latest, timedOut: false });
        }
      });
      const to = setTimeout(() => {
        cleanup();
        const s = this.orch.getConversationSnapshot(conversationId);
        const latest = s.events.length ? s.events[s.events.length - 1]!.seq : sinceSeq;
        resolve({ latestSeq: latest, timedOut: true });
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(to);
        this.orch.unsubscribe(subId);
      };
    });
  }

  async postMessage(params: { conversationId: number; agentId: string; text: string; finality: 'none'|'turn'|'conversation'; attachments?: NonNullable<MessagePayload['attachments']>; clientRequestId?: string; turnHint?: number }) {
    const payload: MessagePayload = { text: params.text };
    if (params.attachments) payload.attachments = params.attachments;
    if (params.clientRequestId) payload.clientRequestId = params.clientRequestId;
    const res = this.orch.appendEvent({
      conversation: params.conversationId,
      type: 'message',
      payload,
      finality: params.finality,
      agentId: params.agentId,
      ...(params.turnHint !== undefined ? { turn: params.turnHint } : {}),
    });
    return { seq: res.seq, turn: res.turn, event: res.event };
  }

  async postTrace(params: { conversationId: number; agentId: string; payload: TracePayload; turn?: number; clientRequestId?: string }) {
    const res = this.orch.appendEvent({
      conversation: params.conversationId,
      type: 'trace',
      payload: params.payload,
      finality: 'none',
      agentId: params.agentId,
      ...(params.turn !== undefined ? { turn: params.turn } : {}),
    });
    return { seq: res.seq, turn: res.turn, event: res.event };
  }

  now(): Date {
    return new Date();
  }
}

function computeGuidance(
  events: any[],
  status: 'active' | 'completed'
): { kind: 'you_may_speak' | 'wait' | 'closed' | 'unknown'; note?: string } {
  if (status === 'completed') return { kind: 'closed' };
  if (!events.length) return { kind: 'you_may_speak' };
  const lastMsg = [...events].reverse().find((e) => e.type === 'message');
  if (!lastMsg) return { kind: 'unknown' };
  if (lastMsg.finality === 'turn') return { kind: 'you_may_speak' };
  if (lastMsg.finality === 'none') return { kind: 'wait', note: `${lastMsg.agentId} is still working` };
  if (lastMsg.finality === 'conversation') return { kind: 'closed' };
  return { kind: 'unknown' };
}
```

```ts
// src/agents/clients/ws.client.ts
import type { IAgentClient } from '$src/agents/agent.types';
import type { MessagePayload, TracePayload } from '$src/types/event.types';

type JsonRpcRequest = { id: string; method: string; params?: any; jsonrpc: '2.0' };
type JsonRpcResponse = { id: string; result?: any; error?: { code: number; message: string; data?: any }; jsonrpc: '2.0' };
type JsonRpcNotification = { method: string; params: any; jsonrpc: '2.0' };

export type WsClientOptions = {
  url: string; // ws://host/api/ws
  onEvent?: (e: any) => void;
  reconnect?: boolean;
  reconnectDelayMs?: number;
};

export class WsJsonRpcClient implements IAgentClient {
  private ws?: WebSocket;
  private url: string;
  private pending = new Map<string, (res: any, err?: any) => void>();
  private onEvent?: (e: any) => void;
  private reconnect: boolean;
  private reconnectDelay: number;

  constructor(opts: WsClientOptions) {
    this.url = opts.url;
    this.onEvent = opts.onEvent;
    this.reconnect = opts.reconnect ?? true;
    this.reconnectDelay = opts.reconnectDelayMs ?? 500;
  }

  private connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => resolve();
      ws.onmessage = (evt) => this.handleMessage(evt.data);
      ws.onclose = () => {
        if (this.reconnect) setTimeout(() => this.connect().catch(() => {}), this.reconnectDelay);
      };
      ws.onerror = (err) => reject(err);
    });
  }

  private handleMessage(raw: any) {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.method && !msg.id) {
      const note = msg as JsonRpcNotification;
      if (note.method === 'event' && this.onEvent) this.onEvent(note.params);
      return;
    }
    const res = msg as JsonRpcResponse;
    const resolver = this.pending.get(String(res.id));
    if (resolver) {
      this.pending.delete(String(res.id));
      if (res.error) resolver(undefined, res.error);
      else resolver(res.result);
    }
  }

  private call<T = any>(method: string, params?: any): Promise<T> {
    return this.connect().then(() => {
      return new Promise<T>((resolve, reject) => {
        const id = crypto.randomUUID();
        const req: JsonRpcRequest = { id, method, params, jsonrpc: '2.0' };
        this.pending.set(id, (result, err) => {
          if (err) reject(new Error(err.message || 'RPC error'));
          else resolve(result as T);
        });
        this.ws!.send(JSON.stringify(req));
      });
    });
  }

  // IAgentClient

  async getSnapshot(conversationId: number) {
    return this.call('getConversation', { conversationId });
  }

  async getUpdatesOrGuidance(conversationId: number, sinceSeq = 0, limit = 200, timeoutMs = 0) {
    if (timeoutMs <= 0) {
      const snap = await this.getSnapshot(conversationId);
      const msgs = snap.events.filter((e: any) => e.type === 'message' && e.seq > sinceSeq).slice(0, limit);
      const latestSeq = snap.events.length ? snap.events[snap.events.length - 1]!.seq : sinceSeq;
      const g = computeGuidance(snap.events, snap.status);
      return { latestSeq, status: snap.status, messages: msgs, guidance: g.kind, note: g.note, timedOut: false };
    }
    const latest = await this.waitForChange(conversationId, sinceSeq, timeoutMs);
    const snap = await this.getSnapshot(conversationId);
    const msgs = snap.events.filter((e: any) => e.type === 'message' && e.seq > sinceSeq).slice(0, limit);
    const g = computeGuidance(snap.events, snap.status);
    return { latestSeq: latest.latestSeq, status: snap.status, messages: msgs, guidance: g.kind, note: g.note, timedOut: latest.timedOut };
  }

  async waitForChange(conversationId: number, sinceSeq: number, timeoutMs: number) {
    let latestSeq = sinceSeq;
    const { subId } = await this.call<{ subId: string }>('subscribe', { conversationId });
    let resolved = false;
    const done = (res: { latestSeq: number; timedOut: boolean }) => {
      if (resolved) return;
      resolved = true;
      this.call('unsubscribe', { subId }).catch(() => {});
      resolver(res);
    };
    let resolver!: (res: { latestSeq: number; timedOut: boolean }) => void;
    const p = new Promise<{ latestSeq: number; timedOut: boolean }>((resolve) => { resolver = resolve; });

    const timeoutId = setTimeout(async () => {
      const snap = await this.getSnapshot(conversationId);
      const latest = snap.events.length ? snap.events[snap.events.length - 1]!.seq : sinceSeq;
      clearTimeout(timeoutId);
      done({ latestSeq: latest, timedOut: true });
    }, timeoutMs);

    const originalOnEvent = this.onEvent;
    this.onEvent = (e) => {
      latestSeq = Math.max(latestSeq, e.seq);
      if (latestSeq > sinceSeq) {
        clearTimeout(timeoutId);
        this.onEvent = originalOnEvent;
        done({ latestSeq, timedOut: false });
      }
      if (originalOnEvent) originalOnEvent(e);
    };

    return p;
  }

  async postMessage(params: { conversationId: number; agentId: string; text: string; finality: 'none'|'turn'|'conversation'; attachments?: NonNullable<MessagePayload['attachments']>; clientRequestId?: string; turnHint?: number }) {
    await this.call('sendMessage', {
      conversationId: params.conversationId,
      agentId: params.agentId,
      messagePayload: { text: params.text, attachments: params.attachments, clientRequestId: params.clientRequestId },
      finality: params.finality,
      currentTurn: params.turnHint
    });
    const snap = await this.getSnapshot(params.conversationId);
    const last = snap.events[snap.events.length - 1]!;
    return { seq: last.seq, turn: last.turn, event: last.event };
  }

  async postTrace(params: { conversationId: number; agentId: string; payload: TracePayload; turn?: number; clientRequestId?: string }) {
    await this.call('sendTrace', {
      conversationId: params.conversationId,
      agentId: params.agentId,
      tracePayload: params.payload,
      currentTurn: params.turn
    });
    const snap = await this.getSnapshot(params.conversationId);
    const last = snap.events[snap.events.length - 1]!;
    return { seq: last.seq, turn: last.turn, event: last.event };
  }

  now(): Date {
    return new Date();
  }
}

function computeGuidance(
  events: any[],
  status: 'active' | 'completed'
): { kind: 'you_may_speak' | 'wait' | 'closed' | 'unknown'; note?: string } {
  if (status === 'completed') return { kind: 'closed' };
  if (!events.length) return { kind: 'you_may_speak' };
  const lastMsg = [...events].reverse().find((e) => e.type === 'message');
  if (!lastMsg) return { kind: 'unknown' };
  if (lastMsg.finality === 'turn') return { kind: 'you_may_speak' };
  if (lastMsg.finality === 'none') return { kind: 'wait', note: `${lastMsg.agentId} is still working` };
  if (lastMsg.finality === 'conversation') return { kind: 'closed' };
  return { kind: 'unknown' };
}
```

Stage C — Agents
Goals
- Implement agents that use only `AgentContext.client`.

Files
- `src/agents/echo.agent.ts`
- `src/agents/script/script.types.ts`
- `src/agents/script/script.agent.ts`

Source
```ts
// src/agents/echo.agent.ts
import type { Agent, AgentContext, TurnOutcome } from '$src/agents/agent.types';

export class EchoAgent implements Agent {
  constructor(private progressText = 'Processing...', private finalText = 'Done') {}

  async handleTurn(ctx: AgentContext): Promise<TurnOutcome> {
    await ctx.client.postMessage({ conversationId: ctx.conversationId, agentId: ctx.agentId, text: this.progressText, finality: 'none' });
    await ctx.client.postMessage({ conversationId: ctx.conversationId, agentId: ctx.agentId, text: this.finalText, finality: 'turn' });
    return 'posted';
  }
}
```

```ts
// src/agents/script/script.types.ts
export type ScriptAction =
  | { kind: 'post'; text: string; finality?: 'none'|'turn'|'conversation'; delayMs?: number }
  | { kind: 'trace'; payload: { type: 'thought' | 'tool_call' | 'tool_result'; [k: string]: any }; delayMs?: number }
  | { kind: 'wait'; timeoutMs: number }
  | { kind: 'sleep'; ms: number }
  | { kind: 'assert'; predicate: 'lastMessageContains'; text: string }
  | { kind: 'yield' };

export interface AgentScript {
  name: string;
  steps: ScriptAction[];
}
```

```ts
// src/agents/script/script.agent.ts
import type { Agent, AgentContext, TurnOutcome } from '$src/agents/agent.types';
import type { AgentScript, ScriptAction } from './script.types';

export class ScriptAgent implements Agent {
  constructor(private script: AgentScript) {}

  async handleTurn(ctx: AgentContext): Promise<TurnOutcome> {
    for (const step of this.script.steps) {
      switch (step.kind) {
        case 'sleep':
          await sleep(step.ms);
          break;
        case 'wait': {
          const snap = await ctx.client.getSnapshot(ctx.conversationId);
          const latest = snap.events.length ? snap.events[snap.events.length - 1]!.seq : 0;
          await ctx.client.waitForChange(ctx.conversationId, latest, step.timeoutMs);
          break;
        }
        case 'trace':
          if (step.delayMs) await sleep(step.delayMs);
          await ctx.client.postTrace({ conversationId: ctx.conversationId, agentId: ctx.agentId, payload: step.payload });
          break;
        case 'post':
          if (step.delayMs) await sleep(step.delayMs);
          await ctx.client.postMessage({ conversationId: ctx.conversationId, agentId: ctx.agentId, text: step.text, finality: step.finality ?? 'turn' });
          if ((step.finality ?? 'turn') !== 'none') {
            return (step.finality === 'conversation') ? 'complete' : 'posted';
          }
          break;
        case 'assert':
          await assertPredicate(ctx, step);
          break;
        case 'yield':
          return 'yield';
      }
    }
    return 'no_action';
  }
}

async function assertPredicate(ctx: AgentContext, step: Extract<ScriptAction, {kind:'assert'}>) {
  const snap = await ctx.client.getSnapshot(ctx.conversationId);
  const lastMsg = [...snap.events].reverse().find((e: any) => e.type === 'message');
  if (!lastMsg) throw new Error('assert failed: no last message');
  if (step.predicate === 'lastMessageContains') {
    const text = (lastMsg.payload?.text ?? '') as string;
    if (!text.includes(step.text)) throw new Error(`assert failed: last message does not contain "${step.text}"`);
  } else {
    throw new Error(`unknown predicate: ${step.predicate}`);
  }
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
```

Stage D — Executors
Goals
- Internal one-shot executor for in-process testing.
- External loop executor for WebSocket-driven agents in a separate process.

Files
- `src/server/orchestrator/internal.executor.ts`
- `src/agents/external/external.executor.ts`

Source
```ts
// src/server/orchestrator/internal.executor.ts
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { Agent } from '$src/agents/agent.types';
import { InProcessClient } from '$src/agents/clients/inprocess.client';

export class InternalExecutor {
  constructor(private orch: OrchestratorService) {}

  async runOne(conversationId: number, agentId: string, agent: Agent, deadlineMs = 30_000): Promise<void> {
    const client = new InProcessClient(this.orch);
    const ctx = { conversationId, agentId, deadlineMs, client, logger: console };
    await agent.handleTurn(ctx);
  }
}
```

```ts
// src/agents/external/external.executor.ts
import type { Agent } from '$src/agents/agent.types';
import { WsJsonRpcClient } from '$src/agents/clients/ws.client';

type LoopOptions = {
  conversationId: number;
  agentId: string;
  url: string; // ws://host/api/ws
  decideIfMyTurn?: (events: any[]) => boolean;
  pollTimeoutMs?: number;
};

export class ExternalExecutor {
  private running = false;
  private sinceSeq = 0;

  constructor(private agent: Agent, private opts: LoopOptions) {}

  async startLoop(): Promise<void> {
    const client = new WsJsonRpcClient({
      url: this.opts.url,
      onEvent: (e) => this.onEvent(e, client),
    });

    const snap = await client.getSnapshot(this.opts.conversationId);
    this.sinceSeq = snap.events.length ? snap.events[snap.events.length - 1]!.seq : 0;

    const pollTimeoutMs = this.opts.pollTimeoutMs ?? 1500;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await client.getUpdatesOrGuidance(this.opts.conversationId, this.sinceSeq, 200, pollTimeoutMs);
      this.sinceSeq = Math.max(this.sinceSeq, res.latestSeq);
      if (res.status === 'completed') return;
      if (res.guidance === 'you_may_speak' && !this.running && this.isMyTurn(res.messages)) {
        await this.runOnce(client);
      }
    }
  }

  private async onEvent(_e: any, client: WsJsonRpcClient) {
    if (this.running) return;
    const snap = await client.getSnapshot(this.opts.conversationId);
    const latestSeq = snap.events.length ? snap.events[snap.events.length - 1]!.seq : this.sinceSeq;
    this.sinceSeq = Math.max(this.sinceSeq, latestSeq);
    if (snap.status === 'completed') return;
    if (this.isMyTurn(snap.events)) {
      await this.runOnce(client);
    }
  }

  private isMyTurn(events: any[]): boolean {
    if (this.opts.decideIfMyTurn) return this.opts.decideIfMyTurn(events);
    const lastMsg = [...events].reverse().find((e) => e.type === 'message');
    if (!lastMsg) return true;
    if (lastMsg.finality !== 'turn') return false;
    return lastMsg.agentId !== this.opts.agentId;
  }

  private async runOnce(client: WsJsonRpcClient) {
    if (this.running) return;
    this.running = true;
    try {
      const ctx = { conversationId: this.opts.conversationId, agentId: this.opts.agentId, deadlineMs: 30_000, client, logger: console };
      await this.agent.handleTurn(ctx);
      const snap = await client.getSnapshot(this.opts.conversationId);
      this.sinceSeq = snap.events.length ? snap.events[snap.events.length - 1]!.seq : this.sinceSeq;
    } finally {
      this.running = false;
    }
  }
}
```

Stage E — CLI external simulation (WebSocket)
Goals
- Run two agents in a separate CLI process.
- Both connect to an already running server via WebSocket.
- Alternate turns via a simple heuristic.

File
- `src/cli/run-sim-ws.ts`

Source
```ts
#!/usr/bin/env bun
import { ExternalExecutor } from '$src/agents/external/external.executor';
import { EchoAgent } from '$src/agents/echo.agent';

// Usage: bun run src/cli/run-sim-ws.ts ws://localhost:3000/api/ws http://localhost:3000
const wsUrl = Bun.argv[2] ?? 'ws://localhost:3000/api/ws';
const httpBase = Bun.argv[3] ?? 'http://localhost:3000';

async function main() {
  // Create conversation via HTTP
  const resp = await fetch(`${httpBase}/api/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'WS Sim' }),
  });
  if (!resp.ok) throw new Error(`Failed to create conversation: ${resp.status}`);
  const convo = await resp.json();
  const conversationId = convo.conversation as number;
  console.log(`Conversation ${conversationId} created`);

  const agentA = new EchoAgent('Agent A thinking...', 'Agent A done');
  const agentB = new EchoAgent('Agent B thinking...', 'Agent B done');

  const exA = new ExternalExecutor(agentA, {
    url: wsUrl,
    conversationId,
    agentId: 'agent-a',
    decideIfMyTurn: (events) => {
      const lastMsg = [...events].reverse().find((e) => e.type === 'message');
      if (!lastMsg) return true; // A starts
      if (lastMsg.finality !== 'turn') return false;
      return lastMsg.agentId !== 'agent-a';
    },
  });

  const exB = new ExternalExecutor(agentB, {
    url: wsUrl,
    conversationId,
    agentId: 'agent-b',
    decideIfMyTurn: (events) => {
      const lastMsg = [...events].reverse().find((e) => e.type === 'message');
      if (!lastMsg) return false; // B waits for A
      if (lastMsg.finality !== 'turn') return false;
      return lastMsg.agentId !== 'agent-b';
    },
  });

  await Promise.race([
    (async () => { await exA.startLoop(); })(),
    (async () => { await exB.startLoop(); })(),
    // Safety timeout
    new Promise((_, rej) => setTimeout(() => rej(new Error('Simulation timeout')), 10_000)),
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Stage F — CLI internal simulation (in-process)
Goals
- Run the same agents in-process using the internal executor.

File
- `src/cli/run-sim-inproc.ts`

Source
```ts
#!/usr/bin/env bun
import { App } from '$src/server/app';
import { InternalExecutor } from '$src/server/orchestrator/internal.executor';
import { EchoAgent } from '$src/agents/echo.agent';

function printEvent(e: any) {
  const text = e.type === 'message' ? e.payload?.text ?? '' : JSON.stringify(e.payload);
  console.log(`[${e.seq}] (${e.turn}:${e.event}) ${e.agentId} ${e.type}/${e.finality} :: ${text}`);
}

async function main() {
  const app = new App({ dbPath: ':memory:', emitNextCandidates: false });
  const orch = app.orchestrator;
  const exec = new InternalExecutor(orch);

  const conversationId = orch.createConversation({ title: 'InProc Sim' });
  const subId = orch.subscribe(conversationId, printEvent);

  const agentA = new EchoAgent('Agent A thinking...', 'Agent A done');
  const agentB = new EchoAgent('Agent B thinking...', 'Agent B done');

  await exec.runOne(conversationId, 'agent-a', agentA);
  await exec.runOne(conversationId, 'agent-b', agentB);
  await exec.runOne(conversationId, 'agent-a', agentA);
  await exec.runOne(conversationId, 'agent-b', agentB);

  orch.sendMessage(conversationId, 'agent-a', { text: 'Closing' }, 'conversation');

  await sleep(100);
  orch.unsubscribe(subId);
  await app.shutdown();
  console.log('In-process simulation completed.');
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Stage G — Tests
Goals
- Smoke test WebSocket client and external executor (requires server entry `src/server/index` providing WS JSON-RPC).
- Internal executor integration test.

Files
- `src/agents/clients/ws.client.test.ts`
- `src/agents/external/external.executor.test.ts`
- `src/server/orchestrator/internal.executor.test.ts`

Source
```ts
// src/agents/clients/ws.client.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import server from '$src/server/index';
import { WsJsonRpcClient } from '$src/agents/clients/ws.client';

let srv: any;

describe('WsJsonRpcClient (smoke)', () => {
  beforeAll(async () => {
    srv = Bun.serve(server);
  });

  afterAll(async () => {
    srv.stop(true);
  });

  it('connects and posts a message', async () => {
    const url = `ws://localhost:${srv.port}/api/ws`;
    const client = new WsJsonRpcClient({ url });

    const resp = await fetch(`http://localhost:${srv.port}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'WS Test' }),
    });
    const convo = await resp.json();
    const conversationId = convo.conversation as number;

    const res = await client.postMessage({ conversationId, agentId: 'ws-agent', text: 'hello', finality: 'turn' });
    expect(res.seq).toBeGreaterThan(0);

    const snap = await client.getSnapshot(conversationId);
    expect(snap.events.length).toBe(1);
  });
});
```

```ts
// src/agents/external/external.executor.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import server from '$src/server/index';
import { ExternalExecutor } from '$src/agents/external/external.executor';
import { EchoAgent } from '$src/agents/echo.agent';

let srv: any;

describe('ExternalExecutor (smoke)', () => {
  beforeAll(async () => {
    srv = Bun.serve(server);
  });

  afterAll(async () => {
    srv.stop(true);
  });

  it('runs a loop and posts at least one turn', async () => {
    const port = srv.port;
    const resp = await fetch(`http://localhost:${port}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'External Loop' }),
    });
    const convo = await resp.json();
    const conversationId = convo.conversation as number;

    const agent = new EchoAgent('Working...', 'Done!');
    const loop = new ExternalExecutor(agent, {
      url: `ws://localhost:${port}/api/ws`,
      conversationId,
      agentId: 'agent-a',
      decideIfMyTurn: (events) => {
        const lastMsg = [...events].reverse().find((e) => e.type === 'message');
        return !lastMsg; // speak first
      },
      pollTimeoutMs: 250,
    });

    const p = loop.startLoop();
    await sleep(500);

    const snap = await fetch(`http://localhost:${port}/api/conversations/${conversationId}?includeEvents=true`).then(r => r.json());
    const msgs = snap.events.filter((e: any) => e.type === 'message');
    expect(msgs.length).toBeGreaterThanOrEqual(2);

    srv.stop(true);
    await Promise.race([p, sleep(200)]);
  });
});

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
```

```ts
// src/server/orchestrator/internal.executor.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Storage } from '$src/server/orchestrator/storage';
import { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import { InternalExecutor } from './internal.executor';
import { EchoAgent } from '$src/agents/echo.agent';

describe('InternalExecutor', () => {
  let storage: Storage;
  let orch: OrchestratorService;
  let exec: InternalExecutor;
  let conversationId: number;

  beforeEach(() => {
    storage = new Storage(':memory:');
    orch = new OrchestratorService(storage);
    exec = new InternalExecutor(orch);
    conversationId = orch.createConversation({ title: 'exec-test' });
  });

  afterEach(async () => {
    await orch.shutdown();
    storage.close();
  });

  it('runs agent for one turn and posts messages', async () => {
    await exec.runOne(conversationId, 'assistant', new EchoAgent('Working...', 'Done!'));
    const snap = orch.getConversationSnapshot(conversationId);
    const msgs = snap.events.filter(e => e.type === 'message');
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.finality).toBe('none');
    expect(msgs[1]!.finality).toBe('turn');
  });
});
```

Stage H — Next improvements (optional)
- Turn-claim endpoint to coordinate multiple external processes.
- Server-side `getUpdatesOrGuidance` over JSON-RPC to avoid snapshot recompute on client.
- Richer ScriptAgent features (branching, variables).
- Scenario binding and named agents derived from scenario config (v2 migration).

How to run
- External WS simulation
  - Start your server (must expose `getConversation`, `sendMessage`, `sendTrace`, `subscribe`, `unsubscribe` over WS JSON-RPC and REST `POST /api/conversations`).
  - bun run src/cli/run-sim-ws.ts ws://localhost:3000/api/ws http://localhost:3000
- Internal simulation
  - bun run src/cli/run-sim-inproc.ts
- Tests
  - bun test

Result
- You’ll have two identical agent classes that can operate:
  - externally via a WebSocket client loop in a separate process, and
  - internally via an in-process executor,
  both producing realistic multi-turn conversations against the same orchestrator and invariants.
