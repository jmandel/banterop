# Agent‑to‑Agent (A2A) JSON‑RPC Bridge — Design & Implementation

## Goals

* **Transport:** JSON‑RPC over HTTP only.
* **Streaming:** Yes (SSE frames that carry JSON‑RPC response envelopes).
* **Push notifications:** **No** (return A2A `PushNotificationNotSupportedError` `-32003`).
* **Task ↔ Conversation:** **1:1 mapping**. A new/unspecified task ID ⇒ create a conversation from the `:config64` ConversationMeta.
* **Base URL shape:** mirror MCP bridge; **no `/v1`**; **ends in `/a2a`**.
* **Agent Card:** **per‑scenario** well‑known card at `/:config64/a2a/.well-known/agent-card.json`.
* **Cancellation:** `tasks/cancel` **ends the conversation**, modeled explicitly as **canceled** (not just completed).
* **History:** **Full** history returned in `Task.history` for now.
* **Attachments:** On outbound/streamed artifacts & history, **use URIs** (not inline bytes).
* **Security:** Auth at HTTP layer (e.g., Bearer). No identity in JSON‑RPC payloads.

---

## Key Decisions & Assumptions

1. **External speaker** (the A2A client) is the agent with ID from your meta’s `startingAgentId(meta)`.

   * All `message/send` posts are authored as this external agent.
2. **Turn management** remains identical to your orchestrator rules: only **message** events can set `finality='turn'|'conversation'`. We always post external messages with `finality='turn'`.
3. **Cancellation** is explicit:

   * Bridge calls a new helper `orchestrator.endConversation(conversationId, { authorId, text, outcome })`.
   * The helper appends a final **system-authored message** with `payload.outcome='canceled'` and `finality='conversation'`, and marks the conversation status accordingly.
4. **Agent Card** is served **per config** at `/:config64/a2a/.well-known/agent-card.json` so it can surface scenario‑specific info.

---

## URL Contract

Assuming your bridge router is mounted under `/api/bridge` (same as MCP):

```
POST /api/bridge/:config64/a2a                       # JSON-RPC multiplexer
GET  /api/bridge/:config64/a2a/diag                  # Decode and echo ConversationMeta
GET  /api/bridge/:config64/a2a/.well-known/agent-card.json   # Scenario-specific Agent Card
```

* **All JSON‑RPC methods** are posted to `/:config64/a2a`.
* **Streaming** (`message/stream`, `tasks/resubscribe`) responds with `text/event-stream` and frames shaped as JSON‑RPC responses.

---

## JSON‑RPC Methods (supported)

| Method              | Summary                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `message/send`      | Send a message for the external agent. **No `taskId`** ⇒ create conversation from `:config64`. Returns **Task**. |
| `message/stream`    | Same as `message/send` but returns an SSE stream of JSON‑RPC frames: initial Task + status/artifact updates.     |
| `tasks/get`         | Return the Task snapshot (maps from ConversationSnapshot). **Full history** included.                            |
| `tasks/cancel`      | End the conversation by appending a system message with `finality='conversation'`, `outcome='canceled'`.         |
| `tasks/resubscribe` | Resume streaming updates for an existing task (by `id`).                                                         |

**Not supported:** all push notification endpoints → `-32003`.

### Task State Mapping

* `submitted` — Right after we accept `message/*` (pre‑work).
* `working` — Non‑external activity ongoing; no terminal finality seen.
* `input-required` — Guidance indicates it’s the external agent’s turn.
* `completed` — Last message has `finality='conversation'` **and** not canceled.
* `canceled` — Final message has `finality='conversation'` **and** `payload.outcome='canceled'`.
* `failed` — Internal error path if you choose to model it.

---

## A2A ↔ Orchestrator Mapping

* **Create conversation** from `:config64` using `orchestrator.createConversation({ meta })`, then `lifecycle.ensure(...)` for **internal** agents only.
* **External message**: `orchestrator.sendMessage(conversationId, externalId, payload, 'turn')`.
* **Cancel**: `orchestrator.endConversation(conversationId, { authorId: 'system', text, outcome: 'canceled' })`.
* **Streaming**: `orchestrator.subscribe(conversationId, handler, includeGuidance=true)`; each event is translated to A2A SSE frames:

  * `message` (non‑external) → `artifact-update` with `TextPart` and **file parts with `uri`** for attachments.
  * `guidance` where `nextAgentId === externalId` → `status-update` with `state='input-required'`.
  * message with `finality='conversation'` → terminal `status-update` (`'completed'` or `'canceled'`).

**Attachments in outputs:**
Convert attachment events to A2A `FilePart` with `file.uri="/api/attachments/:id/content"`; never inline bytes on stream/history.

---

## Error Codes

* `-32601` Method not found
* `-32602` Invalid params
* `-32603` Internal error
* `-32001` Task not found
* `-32002` Task cannot be continued (terminal)
* `-32003` Push Notification is not supported
* `-32004` Unsupported operation (e.g., cancel not available yet)

---

## Security

* **HTTP Auth only** (e.g., `Authorization: Bearer ...`).
* The Agent Card advertises Bearer; extend as needed later.

---

# Implementation

> The code below mirrors your MCP bridge style and uses Hono + your orchestrator/lifecycle services.

## 1) Routes: `src/server/routes/bridge.a2a.ts`

```ts
// src/server/routes/bridge.a2a.ts
import { Hono } from 'hono';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { ServerAgentLifecycleManager } from '$src/server/control/server-agent-lifecycle';
import { parseConversationMetaFromConfig64 } from '$src/server/bridge/conv-config.types';
import { A2ABridgeServer } from '$src/server/bridge/a2a-server';
import { buildScenarioAgentCard } from '$src/server/bridge/a2a-wellknown';

export function createA2ARoutes(
  orchestrator: OrchestratorService,
  lifecycle: ServerAgentLifecycleManager
) {
  const app = new Hono();

  // JSON-RPC multiplexer (message/send, message/stream, tasks/*)
  app.post('/:config64/a2a', async (c) => {
    const config64 = c.req.param('config64');
    let body: any = undefined;
    if (c.req.method === 'POST') {
      try { body = await c.req.json(); } catch { body = undefined; }
    }

    const bridge = new A2ABridgeServer({ orchestrator, lifecycle }, config64);
    try {
      return await bridge.handleJsonRpc(c, body);
    } catch (err: any) {
      const id = body?.id ?? null;
      return c.json({ jsonrpc: '2.0', id, error: { code: -32603, message: err?.message ?? 'Internal error' } }, 500);
    }
  });

  // Diagnostics: decode config64 and echo meta
  app.get('/:config64/a2a/diag', (c) => {
    try {
      const meta = parseConversationMetaFromConfig64(c.req.param('config64'));
      return c.json({ ok: true, meta, notes: 'ConversationMeta for this A2A base.' });
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message ?? String(err) }, 400);
    }
  });

  // Scenario-specific Agent Card (well-known, per-config)
  app.get('/:config64/a2a/.well-known/agent-card.json', (c) => {
    const config64 = c.req.param('config64');
    // Build an absolute base URL for this config
    const baseUrl = new URL(c.req.url);
    // Normalize to ".../:config64/a2a"
    baseUrl.pathname = baseUrl.pathname.replace(/\/\.well-known\/agent-card\.json$/, '');
    const card = buildScenarioAgentCard(baseUrl, config64, orchestrator);
    return c.json(card);
  });

  return app;
}
```

---

## 2) Bridge Core: `src/server/bridge/a2a-server.ts`

```ts
// src/server/bridge/a2a-server.ts
import { stream } from 'hono/streaming';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { ServerAgentLifecycleManager } from '$src/server/control/server-agent-lifecycle';
import type { UnifiedEvent } from '$src/types/event.types';
import {
  parseConversationMetaFromConfig64,
  getStartingAgentId,
  type ConvConversationMeta
} from '$src/server/bridge/conv-config.types';

type Deps = {
  orchestrator: OrchestratorService;
  lifecycle: ServerAgentLifecycleManager;
};

type TaskRow = {
  conversationId: number;
  terminal?: 'completed'|'failed'|'canceled';
};

export class A2ABridgeServer {
  private tasks = new Map<string, TaskRow>();

  constructor(private deps: Deps, private config64: string) {}

  async handleJsonRpc(c: any, body: any) {
    const { id, method, params } = body || {};
    const ok = (result: any, status = 200) => c.json({ jsonrpc: '2.0', id, result }, status);
    const err = (code: number, message: string, status = 400) =>
      c.json({ jsonrpc: '2.0', id, error: { code, message } }, status);

    switch (method) {
      case 'message/send':
        try { return ok(await this.handleMessageSend(params)); } catch (e:any) { return this.fail(c, id, e); }

      case 'message/stream':
        return this.handleMessageStream(c, params, id);

      case 'tasks/get':
        try { return ok(await this.handleTasksGet(params)); } catch (e:any) { return this.fail(c, id, e); }

      case 'tasks/cancel':
        try { return ok(await this.handleTasksCancel(params)); } catch (e:any) { return this.fail(c, id, e); }

      case 'tasks/resubscribe':
        return this.handleTasksResubscribe(c, params, id);

      default:
        return err(-32601, 'Method not found', 404);
    }
  }

  private fail(c: any, id: any, e: any) {
    const code = e?.rpc?.code ?? -32603;
    const message = e?.rpc?.message ?? e?.message ?? 'Internal error';
    return c.json({ jsonrpc: '2.0', id, error: { code, message } }, 500);
  }

  private rpcErr(code: number, message: string) {
    const e: any = new Error(message);
    e.rpc = { code, message };
    return e;
  }

  // --------- Handlers ----------

  private async handleMessageSend(params: any) {
    const { message } = params || {};
    const suppliedTaskId: string | undefined = message?.taskId ?? undefined;

    const { conversationId, externalId } = await this.ensureConversation(suppliedTaskId);
    await this.postExternalMessage(conversationId, externalId, message);
    return this.buildTask(conversationId, externalId);
  }

  private async handleMessageStream(c: any, params: any, rpcId: any) {
    const { message } = params || {};
    const suppliedTaskId: string | undefined = message?.taskId ?? undefined;

    const { conversationId, externalId, taskId } = await this.ensureConversation(suppliedTaskId);
    await this.postExternalMessage(conversationId, externalId, message);

    return stream(c, async (s: any) => {
      const initial = await this.buildTask(conversationId, externalId, 'submitted');
      await s.writeSse({ data: JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: initial }) });

      const subId = this.deps.orchestrator.subscribe(
        conversationId,
        async (evt: UnifiedEvent) => {
          try {
            const frame = await this.translateEvent(conversationId, externalId, evt);
            if (!frame) return;
            await s.writeSse({ data: JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: frame }) });

            if (this.isTerminalFrame(frame)) {
              const row = this.tasks.get(taskId);
              if (row) row.terminal = frame.statusUpdate?.status?.state;
              await s.close();
            }
          } catch { /* ignore */ }
        },
        true // includeGuidance snapshot
      );

      s.onClose(() => { try { this.deps.orchestrator.unsubscribe(subId); } catch {} });
    });
  }

  private async handleTasksGet(params: any) {
    const taskId = String(params?.id ?? '');
    const row = this.tasks.get(taskId);
    if (!row) throw this.rpcErr(-32001, 'Task not found');
    const meta = parseConversationMetaFromConfig64(this.config64);
    const externalId = getStartingAgentId(meta);
    return this.buildTask(row.conversationId, externalId);
  }

  private async handleTasksCancel(params: any) {
    const taskId = String(params?.id ?? '');
    const row = this.tasks.get(taskId);
    if (!row) throw this.rpcErr(-32001, 'Task not found');

    try {
      // Preferred helper (see orchestrator extension below):
      await this.deps.orchestrator.endConversation(row.conversationId, {
        authorId: 'system',
        text: 'Conversation canceled by client.',
        outcome: 'canceled'
      });
    } catch {
      // Fallback (if helper not available yet): try a system-authored final message.
      try {
        this.deps.orchestrator.sendMessage(
          row.conversationId,
          'system',
          { text: 'Conversation canceled by client.', outcome: 'canceled' },
          'conversation'
        );
      } catch {
        throw this.rpcErr(-32004, 'Cancellation not supported by underlying orchestrator yet');
      }
    }

    try { await this.deps.lifecycle.stop(row.conversationId); } catch {}

    row.terminal = 'canceled';
    const meta = parseConversationMetaFromConfig64(this.config64);
    const externalId = getStartingAgentId(meta);
    return this.buildTask(row.conversationId, externalId, 'canceled');
  }

  private async handleTasksResubscribe(c: any, params: any, rpcId: any) {
    const taskId = String(params?.id ?? '');
    const row = this.tasks.get(taskId);
    if (!row) throw this.rpcErr(-32001, 'Task not found');

    const meta = parseConversationMetaFromConfig64(this.config64);
    const externalId = getStartingAgentId(meta);

    return stream(c, async (s: any) => {
      const initial = await this.buildTask(row.conversationId, externalId);
      await s.writeSse({ data: JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: initial }) });

      const subId = this.deps.orchestrator.subscribe(
        row.conversationId,
        async (evt: UnifiedEvent) => {
          try {
            const frame = await this.translateEvent(row.conversationId, externalId, evt);
            if (!frame) return;
            await s.writeSse({ data: JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: frame }) });
            if (this.isTerminalFrame(frame)) await s.close();
          } catch { /* ignore */ }
        },
        true
      );

      s.onClose(() => { try { this.deps.orchestrator.unsubscribe(subId); } catch {} });
    });
  }

  // --------- Helpers ----------

  private async ensureConversation(suppliedTaskId?: string) {
    const meta = parseConversationMetaFromConfig64(this.config64);
    const externalId = getStartingAgentId(meta);

    if (suppliedTaskId) {
      const row = this.tasks.get(suppliedTaskId);
      if (!row) throw this.rpcErr(-32001, 'Task not found');
      if (row.terminal) throw this.rpcErr(-32002, 'Task cannot be continued (terminal)');
      return { conversationId: row.conversationId, externalId, taskId: suppliedTaskId };
    }

    // Create from ConversationMeta template
    const agents = meta.agents.map(a => ({
      id: a.id,
      ...(a.agentClass !== undefined ? { agentClass: a.agentClass } : {}),
      ...(a.role !== undefined ? { role: a.role } : {}),
      ...(a.displayName !== undefined ? { displayName: a.displayName } : {}),
      ...(a.avatarUrl !== undefined ? { avatarUrl: a.avatarUrl } : {}),
      ...(a.config !== undefined ? { config: a.config } : {}),
    }));

    const conversationId = this.deps.orchestrator.createConversation({
      meta: {
        ...(meta.title !== undefined ? { title: meta.title } : {}),
        ...(meta.description !== undefined ? { description: meta.description } : {}),
        ...(meta.scenarioId !== undefined ? { scenarioId: meta.scenarioId } : {}),
        agents,
        ...(meta.config !== undefined ? { config: meta.config } : {}),
        custom: { ...(meta.custom ?? {}), bridge: 'a2a' }
      },
    });

    const internalIds = agents.map(a => a.id).filter(id => id !== externalId);
    if (internalIds.length) await this.deps.lifecycle.ensure(conversationId, internalIds);

    const taskId = String(conversationId);
    this.tasks.set(taskId, { conversationId });
    return { conversationId, externalId, taskId };
  }

  private async postExternalMessage(conversationId: number, externalId: string, a2aMsg: any) {
    const parts = Array.isArray(a2aMsg?.parts) ? a2aMsg.parts : [];
    const text = String(parts.find((p: any) => p?.kind === 'text')?.text ?? '');
    const atts = await this.persistUploads(parts);
    const clientRequestId = a2aMsg?.messageId || undefined;

    this.deps.orchestrator.sendMessage(
      conversationId,
      externalId,
      { text, ...(atts.length ? { attachments: atts } : {}), ...(clientRequestId ? { clientRequestId } : {}) },
      'turn'
    );
  }

  // Persist incoming FileParts (bytes/uri). For uri inputs you may choose to store references as-is.
  private async persistUploads(parts: any[]) {
    const out: any[] = [];
    for (const p of parts) {
      if (p?.kind !== 'file') continue;
      const f = p.file || {};
      const name = f.name || 'upload';
      const contentType = f.mimeType || 'application/octet-stream';
      if (f.bytes) {
        out.push({ name, contentType, content: f.bytes });
      } else if (f.uri) {
        // store reference or copy; for now, keep URI as content for later fetchers (optional)
        out.push({ name, contentType, content: f.uri });
      }
    }
    return out;
  }

  private async buildTask(conversationId: number, externalId: string, forceState?: any) {
    const snap = this.deps.orchestrator.getConversationSnapshot(conversationId, { includeScenario: false });
    const id = String(conversationId);
    const state = forceState ?? this.deriveState(snap);
    const artifacts = this.collectArtifacts(snap);
    const history = this.toA2aHistory(snap, externalId);

    return {
      id,
      contextId: id,
      status: { state },
      artifacts,
      history,
      kind: 'task',
      metadata: {}
    };
  }

  private deriveState(snap: any): 'submitted'|'working'|'input-required'|'completed'|'failed'|'canceled' {
    const evts = snap?.events || [];
    const lastMsg = [...evts].reverse().find((e: any) => e.type === 'message');
    if (!lastMsg) return 'submitted';
    if (lastMsg.finality === 'conversation') {
      return lastMsg?.payload?.outcome === 'canceled' ? 'canceled' : 'completed';
    }
    return 'working';
  }

  private collectArtifacts(snap: any) {
    const evts = snap?.events || [];
    const msgs = evts.filter((e: any) => e.type === 'message');
    const textParts = msgs
      .filter((m: any) => !!m?.payload?.text)
      .map((m: any) => ({ kind: 'text', text: String(m.payload.text) }));
    return textParts.length ? [{ artifactId: 'artifact-1', parts: textParts }] : [];
  }

  private toA2aHistory(snap: any, externalId: string) {
    const evts = snap?.events || [];
    const convId = String(snap?.conversation ?? '');
    return evts
      .filter((e: any) => e.type === 'message')
      .map((e: any) => {
        const isExternal = e.agentId === externalId;
        const parts: any[] = [];
        const text = String(e?.payload?.text ?? '');
        if (text) parts.push({ kind: 'text', text });
        const atts = Array.isArray(e?.payload?.attachments) ? e.payload.attachments : [];
        for (const a of atts) {
          // Prefer URIs
          if (a?.id && a?.contentType) {
            parts.push({
              kind: 'file',
              file: {
                name: a.name ?? 'attachment',
                mimeType: a.contentType,
                uri: `/api/attachments/${a.id}/content`
              }
            });
          }
        }
        return {
          role: isExternal ? 'user' : 'agent',
          parts,
          messageId: String(e.event),
          taskId: convId,
          contextId: convId,
          kind: 'message',
          metadata: {}
        };
      });
  }

  private async translateEvent(conversationId: number, externalId: string, evt: any) {
    // Message events ⇒ artifact updates; closing message ⇒ terminal status
    if (evt?.type === 'message') {
      const isExternal = evt.agentId === externalId;
      const parts: any[] = [];
      const text = String(evt?.payload?.text ?? '');
      if (!isExternal && text) {
        parts.push({ kind: 'text', text });
      }
      const atts = Array.isArray(evt?.payload?.attachments) ? evt.payload.attachments : [];
      for (const a of atts) {
        if (a?.id && a?.contentType && !isExternal) {
          parts.push({
            kind: 'file',
            file: { name: a.name ?? 'attachment', mimeType: a.contentType, uri: `/api/attachments/${a.id}/content` }
          });
        }
      }

      if (parts.length) {
        return {
          artifactUpdate: {
            taskId: String(conversationId),
            contextId: String(conversationId),
            artifact: { artifactId: `m-${evt.seq}`, parts },
            append: true,
            lastChunk: false,
            kind: 'artifact-update'
          }
        };
      }

      if (evt.finality === 'conversation') {
        const state = evt?.payload?.outcome === 'canceled' ? 'canceled' : 'completed';
        return {
          statusUpdate: {
            taskId: String(conversationId),
            contextId: String(conversationId),
            status: { state },
            final: true,
            kind: 'status-update'
          }
        };
      }
    }

    // Guidance ⇒ input-required for the external agent
    if (evt?.type === 'guidance' && evt?.nextAgentId === externalId) {
      return {
        statusUpdate: {
          taskId: String(conversationId),
          contextId: String(conversationId),
          status: { state: 'input-required' },
          kind: 'status-update'
        }
      };
    }

    return undefined;
  }

  private isTerminalFrame(frame: any) {
    const st = frame?.statusUpdate?.status?.state;
    return st === 'completed' || st === 'failed' || st === 'canceled';
  }
}
```

---

## 3) Orchestrator helper (new): `endConversation`

Add this **tiny helper** to your orchestrator service (or wherever `sendMessage` lives) so the bridge can model cancelation explicitly and cleanly.

```ts
// src/server/orchestrator/orchestrator.ts
// ...
export interface EndConversationOptions {
  authorId?: string;             // default 'system'
  text?: string;                 // default 'Conversation ended.'
  outcome?: 'completed'|'canceled'|'failed';  // default 'completed'
  metadata?: Record<string, any>;
}

// Append a final message with finality='conversation' and a structured outcome.
// This does NOT "clear turn"; it closes the conversation as a proper terminal message.
export async function endConversation(
  this: OrchestratorService,
  conversationId: number,
  opts: EndConversationOptions = {}
): Promise<void> {
  const authorId = opts.authorId ?? 'system';
  const text = opts.text ?? 'Conversation ended.';
  const outcome = opts.outcome ?? 'completed';

  // MessagePayload in your stack already allows 'outcome?'
  this.sendMessage(
    conversationId,
    authorId,
    { text, outcome, ...(opts.metadata ? { metadata: opts.metadata } : {}) },
    'conversation'  // <— closes the conversation
  );
}
```

> If you prefer not to bind a method on the instance, export a function that takes the `orchestrator` instance and does the same call.

---

## 4) Per‑Scenario Agent Card: `src/server/bridge/a2a-wellknown.ts`

```ts
// src/server/bridge/a2a-wellknown.ts
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import { parseConversationMetaFromConfig64 } from '$src/server/bridge/conv-config.types';

export function buildScenarioAgentCard(baseUrlToA2A: URL, config64: string, orchestrator: OrchestratorService) {
  // baseUrlToA2A points to ".../:config64/a2a"
  // Parse scenario meta to enrich the card (title/agents/examples).
  const meta = parseConversationMetaFromConfig64(config64);

  // Try to derive some friendly info
  let title = meta.title || meta.scenarioId || 'A2A Scenario';
  let agentSummaries: string[] = [];
  try {
    if (meta.scenarioId) {
      const sc = orchestrator.storage?.scenarios?.findScenarioById(meta.scenarioId);
      if (sc) {
        title = sc.config?.metadata?.title || sc.name || title;
        agentSummaries = (sc.config?.agents || []).map((a: any) => {
          const n = a?.principal?.name || a?.agentId || '';
          return `${a.agentId}${n && n !== a.agentId ? ` (${n})` : ''}`;
        });
      }
    }
  } catch { /* ignore */ }

  if (agentSummaries.length === 0) {
    agentSummaries = (meta.agents || []).map(a => `${a.id}${a.displayName ? ` (${a.displayName})` : ''}${a.role ? ` – ${a.role}` : ''}`);
  }

  const externalId = meta.startingAgentId || (meta.agents?.[0]?.id ?? 'external');
  const skillDescription =
    `Conversation facade for scenario "${title}". Agents: ${agentSummaries.join(', ')}. ` +
    `External client speaks as: ${externalId}.`;

  // Minimal, scenario-specific card
  return {
    protocolVersion: '0.2.9',
    name: `A2A Bridge · ${title}`,
    description: 'JSON-RPC A2A facade over the conversation orchestrator (streaming enabled).',
    url: baseUrlToA2A.toString(),
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [
      { url: baseUrlToA2A.toString(), transport: 'JSONRPC' }
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false
    },
    // Security scaffold: Bearer-only for now
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
    },
    security: [{ bearer: [] }],
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    // A simple, scenario-tied "skill" (optional but helps discovery UIs)
    skills: [
      {
        id: 'conversation-facade',
        name: 'Scenario Conversation',
        description: skillDescription,
        tags: ['conversation', 'scenario', 'interop'],
        examples: [
          'Start a new task and send: "Hello, please begin."',
          'Attach a PDF and ask the counterpart to review.',
        ],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json', 'text/plain']
      }
    ],
    // Non-normative hint to explain the config64 nature of this card
    extensions: [
      {
        id: 'a2a.config64',
        name: 'Config64 Binding',
        description: 'This Agent Card is scoped to the ConversationMeta encoded in the URL path.',
        config64
      }
    ]
  };
}
```

---

# End‑to‑End Flow (quick examples)

### 1) Create & send (no `taskId`)

* Client calls `POST /api/bridge/:config64/a2a` with:

```json
{ "jsonrpc":"2.0","id":1,"method":"message/send","params":{
  "message": { "role":"user","parts":[{ "kind":"text","text":"Hello!" }] }
}}
```

* Bridge creates conversation, ensures internal agents, posts external message with `finality='turn'`, returns `Task` with `id = conversationId`.

### 2) Stream

* Same payload but `method="message/stream"` → SSE:

  * Frame 1: Task snapshot (state `submitted`).
  * Next frames: `artifact-update` (non‑external messages, with text + file `uri`s).
  * Guidance where `nextAgentId === external` → `status-update state='input-required'`.
  * Final: `status-update` with `completed` or `canceled` and `final=true`.

### 3) Cancel

```json
{ "jsonrpc":"2.0","id":3,"method":"tasks/cancel","params":{"id":"<conversationId>" } }
```

* Bridge calls `orchestrator.endConversation(..., outcome:'canceled')`, returns Task with `status.state='canceled'`.

---

# Testing Plan

1. **Conversation creation path**

   * `message/send` without `taskId` ⇒ new conversation; verify internal agents ensured.
2. **Streaming path**

   * `message/stream` yields initial Task frame, later `artifact-update` frames, terminal `status-update`.
3. **History**

   * `tasks/get` returns **full** message history; external messages have `role='user'`, others `role='agent'`.
   * Attachments in history are **file parts with `uri`** to `/api/attachments/:id/content`.
4. **Cancel**

   * After `tasks/cancel`, `tasks/get` reports `status.state='canceled'`; last message has `finality='conversation'` and `payload.outcome='canceled'`.
5. **Errors**

   * Unknown method → `-32601`.
   * Unknown task → `-32001`.
   * Continuing terminal task → `-32002`.
   * Push-notification (if called) → `-32003`.

---

# Notes & TODOs

* **Orchestrator helper**: adopt the `endConversation(...)` helper (above). It’s minimal and keeps the bridge clean.
* **System author ID**: standardized as `'system'`. No per‑scenario config required.
* **State derivation**: currently simple; if you expose richer runtime status we can refine the mapping.
* **Artifacts strategy**: we aggregate message texts into a single artifact in snapshots; streaming emits one artifact per non‑external message. Adjust as desired.
* **Security**: card lists Bearer; wire up real auth checks in the route if needed.
* **Future**: If you later want a **global** catalog, you can add a top‑level index that links to many per‑scenario cards (each under its `/:config64/a2a/.well-known/...`).

---

If you want, I can produce a small PR‑ready patch (diff) against your repo layout next.
