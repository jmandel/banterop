Dev plan: intentional hybrid API, no flags, no deprecations

What’s changing and why
- Single transport for conversation lifecycle and streaming: WebSocket JSON-RPC. This unifies idempotency, sequencing, replay (sinceSeq), filtering, and live fanout behind one consistent contract.
- Keep HTTP only where it’s best:
  - Scenarios CRUD (existing).
  - Attachments binary content fetch via HTTP streaming.
  - Minimal attachment metadata GET by id (useful for simple debug/UI).
  - Health check.
- Remove conversation REST routes entirely to avoid duplication and drift.
- Make orchestrator.sendMessage and orchestrator.sendTrace return AppendEventResult so clients get seq, ts, turn, event consistently.
- Standardize JSON-RPC error codes for invariants.

Final API surface

HTTP
- GET /health
- Scenarios (unchanged): GET/POST/PUT/DELETE /api/scenarios, /api/scenarios/:id
- Attachments
  - GET /api/attachments/:id          -> AttachmentRow (metadata)
  - GET /api/attachments/:id/content  -> bytes with content-type

WebSocket JSON-RPC
- subscribe { conversationId, includeGuidance?, filters?, sinceSeq? } -> { subId }
- subscribeAll { includeGuidance? } -> { subId }
- unsubscribe { subId } -> { ok: true }
- ping {} -> { ok: true, ts: string }

- createConversation CreateConversationRequest -> { conversationId }
- listConversations { status?, scenarioId?, limit?, offset? } -> { conversations: ConversationRow[] }
- getConversation { conversationId } -> ConversationSnapshot
- getHydratedConversation { conversationId } -> HydratedConversationSnapshot

- sendMessage { conversationId, agentId, messagePayload, finality, turn? } -> AppendEventResult
- sendTrace { conversationId, agentId, tracePayload, turn? } -> AppendEventResult
- claimTurn { conversationId, agentId, guidanceSeq } -> { ok: boolean, reason?: string }

- getEventsPage { conversationId, afterSeq?, limit? } -> { events: UnifiedEvent[], nextAfterSeq?: number }

Note:
- Listing attachments by conversation is a conversation-scoped concern; it will be via WS (getEventsPage or getConversation already give you message payloads with attachment refs). We will not ship a separate HTTP “list by conversation” route; for direct inspection, GET by id remains via HTTP.

Error codes (JSON-RPC)
- -32010 TurnClosed
- -32011 ConversationFinalized
- -32012 IdempotentDuplicate (reserved if we surface explicit idempotent hit)
- -32013 InvalidFinality
- -32020 ValidationError
- -32000 Generic server error
- Keep -32601 MethodNotFound, -32700 ParseError

Step-by-step implementation

1) Orchestrator returns AppendEventResult
File: src/server/orchestrator/orchestrator.ts

Change sendTrace/sendMessage to return AppendEventResult and bubble through appendEvent.

```ts
// imports unchanged

export class OrchestratorService {
  // ...

  sendTrace(
    conversation: number,
    agentId: string,
    payload: TracePayload,
    turn?: number
  ): AppendEventResult {
    const targetTurn = turn ?? this.tryFindOpenTurn(conversation);
    return this.appendEvent({
      conversation,
      ...(targetTurn !== undefined ? { turn: targetTurn } : {}),
      type: 'trace',
      payload,
      finality: 'none',
      agentId,
    });
  }

  sendMessage(
    conversation: number,
    agentId: string,
    payload: MessagePayload,
    finality: Finality,
    turn?: number
  ): AppendEventResult {
    const input: AppendEventInput<MessagePayload> = {
      conversation,
      type: 'message',
      payload,
      finality,
      agentId,
      ...(turn !== undefined ? { turn } : {}),
    };
    return this.appendEvent(input);
  }

  // (Optionally expose events paging)
  getEventsPage(conversationId: number, afterSeq?: number, limit?: number) {
    return this.storage.events.getEventsPage(conversationId, afterSeq, limit);
  }
}
```

2) EventStore paging helper
File: src/db/event.store.ts

```ts
getEventsPage(conversation: number, afterSeq?: number, limit: number = 200): UnifiedEvent[] {
  const rows = this.db
    .prepare(
      `SELECT conversation, turn, event, type, payload, finality, ts, agent_id as agentId, seq
       FROM conversation_events
       WHERE conversation = ?
         ${afterSeq ? 'AND seq > ?' : ''}
       ORDER BY seq ASC
       LIMIT ?`
    )
    .all(...(afterSeq !== undefined ? [conversation, afterSeq, limit] : [conversation, limit])) as Array<{
      conversation: number; turn: number; event: number; type: string; payload: string; finality: string; ts: string; agentId: string; seq: number;
    }>;

  return rows.map(r => ({
    conversation: r.conversation,
    turn: r.turn,
    event: r.event,
    type: r.type as UnifiedEvent['type'],
    payload: JSON.parse(r.payload),
    finality: r.finality as Finality,
    ts: r.ts,
    agentId: r.agentId,
    seq: r.seq,
  }));
}
```

3) WS server: add RPCs, map errors, return AppendEventResult
File: src/server/ws/jsonrpc.server.ts

Add error mapping and new handlers. Keep existing subscribe/trace/message handlers but return orchestrator’s results.

```ts
function mapError(e: unknown): { code: number; message: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Turn already finalized/i.test(msg)) return { code: -32010, message: msg };
  if (/Conversation is finalized/i.test(msg) || /finalized/i.test(msg)) return { code: -32011, message: msg };
  if (/Only message events may set finality/i.test(msg)) return { code: -32013, message: msg };
  // Optionally detect idempotency duplicate if message text is added
  return { code: -32000, message: msg };
}
```

Add cases:

```ts
if (method === 'ping') {
  ws.send(JSON.stringify(ok(id, { ok: true, ts: new Date().toISOString() })));
  return;
}

if (method === 'createConversation') {
  try {
    const params = req.params as import('$src/types/conversation.meta').CreateConversationRequest;
    const conversationId = orchestrator.createConversation(params);
    ws.send(JSON.stringify(ok(id, { conversationId })));
  } catch (e) {
    const { code, message } = mapError(e);
    ws.send(JSON.stringify(errResp(id, code, message)));
  }
  return;
}

if (method === 'listConversations') {
  try {
    const params = req.params as import('$src/db/conversation.store').ListConversationsParams;
    const conversations = orchestrator.listConversations(params);
    ws.send(JSON.stringify(ok(id, { conversations })));
  } catch (e) {
    const { code, message } = mapError(e);
    ws.send(JSON.stringify(errResp(id, code, message)));
  }
  return;
}

if (method === 'getHydratedConversation') {
  const { conversationId } = req.params as { conversationId: number };
  try {
    const snap = orchestrator.getHydratedConversationSnapshot(conversationId);
    if (!snap) return ws.send(JSON.stringify(errResp(id, 404, 'Conversation not found')));
    ws.send(JSON.stringify(ok(id, snap)));
  } catch (e) {
    const { code, message } = mapError(e);
    ws.send(JSON.stringify(errResp(id, code, message)));
  }
  return;
}

if (method === 'getEventsPage') {
  const { conversationId, afterSeq, limit } = req.params as { conversationId: number; afterSeq?: number; limit?: number };
  try {
    const events = orchestrator.getEventsPage(conversationId, afterSeq, limit);
    const nextAfterSeq = events.length ? events[events.length - 1]!.seq : afterSeq;
    ws.send(JSON.stringify(ok(id, { events, nextAfterSeq })));
  } catch (e) {
    const { code, message } = mapError(e);
    ws.send(JSON.stringify(errResp(id, code, message)));
  }
  return;
}

// Update existing sendTrace/sendMessage handlers to return AppendEventResult:
if (method === 'sendTrace') {
  const { conversationId, agentId, tracePayload, turn } = req.params as {
    conversationId: number; agentId: string; tracePayload: TracePayload; turn?: number;
  };
  try {
    const res = orchestrator.sendTrace(conversationId, agentId, tracePayload, turn);
    ws.send(JSON.stringify(ok(id, res)));
  } catch (e) {
    const { code, message } = mapError(e);
    ws.send(JSON.stringify(errResp(id, code, message)));
  }
  return;
}

if (method === 'sendMessage') {
  const { conversationId, agentId, messagePayload, finality, turn } = req.params as {
    conversationId: number; agentId: string; messagePayload: MessagePayload; finality: Finality; turn?: number;
  };
  try {
    const res = orchestrator.sendMessage(conversationId, agentId, messagePayload, finality, turn);
    ws.send(JSON.stringify(ok(id, res)));
  } catch (e) {
    const { code, message } = mapError(e);
    ws.send(JSON.stringify(errResp(id, code, message)));
  }
  return;
}
```

4) Types: add WS RPC shapes
File: src/types/api.types.ts

```ts
export interface CreateConversationRpcResult { conversationId: number; }
export interface ListConversationsRpcParams {
  status?: 'active' | 'completed';
  scenarioId?: string;
  limit?: number;
  offset?: number;
}
export interface ListConversationsRpcResult {
  conversations: import('$src/db/conversation.store').ConversationRow[];
}

export interface GetEventsPageParams { conversationId: number; afterSeq?: number; limit?: number; }
export interface GetEventsPageResult { events: import('./event.types').UnifiedEvent[]; nextAfterSeq?: number; }
```

5) HTTP server: mount only scenarios, attachments, health, and WS
File: src/server/index.ts

- Remove mounting of conversations.http.ts completely.
- Keep scenarios.http.ts and createWebSocketServer.
- Keep attachments GETs and health. If your attachments GET handlers are currently in conversations.http.ts, move them to a new attachments.http.ts.

Example index:

```ts
import { Hono } from 'hono';
import { App } from './app';
import { createWebSocketServer, websocket } from './ws/jsonrpc.server';
import { createScenarioRoutes } from './routes/scenarios.http';
import { createAttachmentRoutes } from './routes/attachments.http';

const appInstance = new App();
const server = new Hono();

server.route('/api/scenarios', createScenarioRoutes(appInstance.orchestrator.storage.scenarios));
server.route('/', createAttachmentRoutes(appInstance.orchestrator)); // new small router for GETs
server.route('/', createWebSocketServer(appInstance.orchestrator));
server.get('/health', (c) => c.json({ ok: true }));

process.on('SIGTERM', async () => { await appInstance.shutdown(); process.exit(0); });

export default { port: Number(process.env.PORT ?? 3000), fetch: server.fetch, websocket };
```

New file: src/server/routes/attachments.http.ts

```ts
import { Hono } from 'hono';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';

export function createAttachmentRoutes(orchestrator: OrchestratorService) {
  const app = new Hono();

  app.get('/api/attachments/:id', (c) => {
    const id = c.req.param('id');
    const attachment = orchestrator.getAttachment(id);
    if (!attachment) return c.json({ error: 'Attachment not found' }, 404);
    return c.json(attachment);
  });

  app.get('/api/attachments/:id/content', (c) => {
    const id = c.req.param('id');
    const attachment = orchestrator.getAttachment(id);
    if (!attachment) return c.json({ error: 'Attachment not found' }, 404);
    c.header('Content-Type', attachment.contentType);
    c.header('Content-Disposition', `inline; filename="${attachment.name}"`);
    return c.body(attachment.content);
  });

  return app;
}
```

6) Update ClaimClient to rely on real results
File: src/agents/executors/turn-loop.executor.ts

```ts
// In ClaimClient.postMessage()
return { seq: result.seq, turn: result.turn, event: result.event };

// In ClaimClient.postTrace()
return { seq: result.seq, turn: result.turn, event: result.event };
```

7) Clean up: remove conversation REST routes
- Delete src/server/routes/conversations.http.ts or keep only attachment GET handlers moved already.
- Remove any mounting of conversation routes.

8) Update CLIs and tests to WS conversations
- Any CLI using POST /api/conversations now uses WS createConversation RPC.
- ws-integration tests remain valid; add tests for createConversation over WS and listConversations.
- Keep scenarios CRUD tests as-is.

Example WS helper for CLI/tests:

```ts
async function rpc<T>(wsUrl: string, method: string, params?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = crypto.randomUUID();
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params, jsonrpc: '2.0' }));
    ws.onmessage = (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id !== id) return;
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result as T);
    };
    ws.onerror = reject;
  });
}
```

Test additions (high value)
- WS createConversation emits meta_created system event (turn 0 event 1).
- WS listConversations respects filters status/scenarioId/limit/offset.
- WS sendMessage/sendTrace return AppendEventResult; idempotency returns prior seq.
- subscribe with sinceSeq replays backlog then live; filters by types/agents.
- getEventsPage returns bounded page and nextAfterSeq.
- HTTP GET /api/attachments/:id/content streams with correct headers.

Rationale recap
- WS concentrates all conversation logic into a single transport with sequencing and replay; no duplicated REST endpoints or data shape drift.
- HTTP is kept for what it excels at: binary streaming and simple resource reads (attachments) and builder-friendly CRUD (scenarios).
- Returning AppendEventResult everywhere gives clients stable identifiers (seq/turn/event/ts) for telemetry, ordering, and resume.

Acceptance criteria
- No conversation REST endpoints are mounted.
- WS JSON-RPC covers create/list/get/send/trace/claim/subscribe/paging.
- Orchestrator sendMessage/sendTrace return AppendEventResult and WS returns it verbatim.
- Scenarios CRUD remain via HTTP.
- Attachments are retrievable via HTTP GET (metadata and content); conversation-scoped attachment discovery occurs via conversation events over WS.
- All updated unit/integration tests pass.
