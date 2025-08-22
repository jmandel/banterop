import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "bun";
import type { A2APart, A2AFrame, A2AMessage, A2AStatus, A2ATask } from "../shared/a2a-types";

type Role = 'initiator' | 'responder';
const asPublicRole = (s: Role) => s;

type TaskState = {
  id: string;
  side: Role;
  pairId: string;
  status: A2AStatus;
  history: A2AMessage[];
  subscribers: Set<(frame: A2AFrame)=>void>;
};

type Pair = {
  id: string;
  epoch: number;
  turn: Role;
  startingTurn: Role;
  initiatorTask?: TaskState;
  responderTask?: TaskState;
  serverEvents: Set<(ev:any)=>void>;
  eventLog: Set<(ev:any)=>void>;
};

const pairs = new Map<string, Pair>();

const app = new Hono();

// Parse JSON bodies defensively
async function safeJson(c: any): Promise<any> {
  try { return await c.req.json(); } catch { return {}; }
}

// Dev HTML routes powered by Bun.serve; Hono handles only API below.
// (See Bun.serve() at bottom for route mapping.)

// Pair management
app.post('/api/pairs', async (c) => {
  const pairId = shortId();
  const origin = new URL(c.req.url).origin;
  const p: Pair = { id: pairId, epoch: 0, turn: 'initiator', startingTurn: 'initiator', serverEvents: new Set(), eventLog: new Set() };
  pairs.set(pairId, p);
  logEvent(p, { type: 'pair-created', pairId });
  const a2aUrl = `${origin}/api/bridge/${pairId}/a2a`;
  const tasksUrl = `${origin}/pairs/${pairId}/server-events`;
  return c.json({
    pairId,
    // Participant UI links configured with explicit role and endpoints
    aJoinUrl: `${origin}/participant/?role=initiator&a2a=${encodeURIComponent(a2aUrl)}`,
    bJoinUrl: `${origin}/participant/?role=responder&a2a=${encodeURIComponent(a2aUrl)}&tasks=${encodeURIComponent(tasksUrl)}`,
    serverEventsUrl: tasksUrl
  });
});

// Backchannel: only the responder uses this
app.get('/pairs/:pairId/server-events', async (c) => {
  const pairId = c.req.param('pairId');
  const p = mustPair(pairId);
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    const push = (ev: any) => stream.writeSSE({ data: JSON.stringify({ result: ev }) });
    // keepalive pings so intermediaries don't close idle SSE
    const ka = setInterval(() => {
      try { stream.writeSSE({ event: 'ping', data: String(Date.now()) }); } catch {}
    }, 15000);
    p.serverEvents.add(push);
    // immediate subscribe to current epoch if present
    if (p.responderTask) push({ type: 'subscribe', pairId, epoch: p.epoch, taskId: p.responderTask.id, turn: p.turn });
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    p.serverEvents.delete(push);
    clearInterval(ka);
  });
});

// Alias: control plane event tail
app.get('/pairs/:pairId/events.log', async (c) => {
  const pairId = c.req.param('pairId');
  const p = mustPair(pairId);
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    const push = (ev: any) => stream.writeSSE({ data: JSON.stringify({ result: ev }) });
    const ka = setInterval(() => {
      try { stream.writeSSE({ event: 'ping', data: String(Date.now()) }); } catch {}
    }, 15000);
    p.eventLog.add(push);
    if (p.responderTask) push({ type: 'subscribe', pairId, epoch: p.epoch, taskId: p.responderTask.id, turn: p.turn });
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    p.eventLog.delete(push);
    clearInterval(ka);
  });
});

app.post('/pairs/:pairId/reset', async (c) => {
  const pairId = c.req.param('pairId');
  const { type } = await safeJson(c);
  const p = mustPair(pairId);
  if (type === 'soft') {
    // notify server to unsubscribe old
    if (p.responderTask) {
      const ev = { type: 'unsubscribe', pairId, epoch: p.epoch };
      p.serverEvents.forEach(fn => fn(ev));
      logEvent(p, ev);
    }
    // cancel tasks and bump epoch
    if (p.initiatorTask) setTaskStatus(p.initiatorTask, 'canceled');
    if (p.responderTask) setTaskStatus(p.responderTask, 'canceled');
    p.epoch += 1;
    p.turn = p.startingTurn || 'initiator';
    p.initiatorTask = undefined;
    p.responderTask = undefined;
    // create fresh tasks for next epoch (ids allocated now)
    const init = newTask(pairId, 'initiator', `init:${pairId}#${p.epoch}`);
    const resp = newTask(pairId, 'responder', `resp:${pairId}#${p.epoch}`);
    p.initiatorTask = init; p.responderTask = resp;
    // prompt server to subscribe new
    {
      const ev = { type: 'subscribe', pairId, epoch: p.epoch, taskId: resp.id, turn: p.turn };
      p.serverEvents.forEach(fn => fn(ev));
      logEvent(p, ev);
    }
    return c.json({ ok: true, epoch: p.epoch });
  } else {
    // hard: redirect (new pair)
    const origin = new URL(c.req.url).origin;
    const np = shortId();
    const newPair: Pair = { id: np, epoch: 0, turn: 'initiator', startingTurn: 'initiator', serverEvents: new Set(), eventLog: new Set() };
    pairs.set(np, newPair);
    // cancel existing
    if (p.initiatorTask) setTaskStatus(p.initiatorTask, 'canceled');
    if (p.responderTask) setTaskStatus(p.responderTask, 'canceled');
    // notify redirect
    const a2aUrl2 = `${origin}/api/bridge/${np}/a2a`;
    const tasksUrl2 = `${origin}/pairs/${np}/server-events`;
    {
      const ev = {
        type: 'redirect',
        newPair: {
          pairId: np,
          aJoinUrl: `${origin}/participant/?role=initiator&a2a=${encodeURIComponent(a2aUrl2)}`,
          bJoinUrl: `${origin}/participant/?role=responder&a2a=${encodeURIComponent(a2aUrl2)}&tasks=${encodeURIComponent(tasksUrl2)}`
        }
      };
      p.serverEvents.forEach(fn => fn(ev));
      logEvent(p, ev);
    }
    pairs.delete(pairId);
    return c.json({ ok: true, redirectedTo: np });
  }
});

// A2A JSON-RPC bridge (single endpoint)
app.post('/api/bridge/:pairId/a2a', async (c) => {
  const pairId = c.req.param('pairId');
  const p = mustPair(pairId);
  let raw: any;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(jsonrpcError(null, -32700, 'Invalid JSON payload'), 200);
  }
  const method = String(raw?.method || '');
  const id = raw?.id ?? null;
  const params = raw?.params || {};
  if (!method) return c.json(jsonrpcError(id, -32600, 'Invalid Request'), 200);

  if (method === 'message/stream') {
    const msg = params?.message || {};
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      // Determine side and task; create if absent
      let side: Role | null = null;
      let task: TaskState | undefined;
      if (msg.taskId) {
        task = getTaskById(p, String(msg.taskId));
        side = task?.side || null;
      }
      if (!task) {
        // Treat as new epoch from initiator
        side = 'initiator';
        // if no tasks exist for this epoch, create them
        if (!p.initiatorTask || !p.responderTask) {
          p.epoch += 1;
          p.turn = p.startingTurn || 'initiator';
          p.initiatorTask = newTask(pairId, 'initiator', `init:${pairId}#${p.epoch}`);
          p.responderTask = newTask(pairId, 'responder', `resp:${pairId}#${p.epoch}`);
          // tell responder to subscribe
          {
            const ev = { type:'subscribe', pairId, epoch: p.epoch, taskId: p.responderTask!.id, turn: p.turn };
            p.serverEvents.forEach(fn => fn(ev));
            logEvent(p, ev);
          }
        }
        task = p.initiatorTask;
      }
      const t = task!;
      const push = (frame: A2AFrame) => {
        const payload = { jsonrpc: '2.0', id, result: frame.result };
        stream.writeSSE({ data: JSON.stringify(payload) });
        logEvent(p, { type: 'a2a-frame', to: asPublicRole(t.side), frame: payload });
      };
      t.subscribers.add(push);
      // Let caller know the task snapshot first
      push({ result: taskSnapshot(t) });
      // If a message payload was provided, record & reflect
      const parts = Array.isArray(msg.parts) ? msg.parts : [];
      if (parts.length) {
        const validation = validateParts(parts);
        if (!validation.ok) {
          stream.writeSSE({ data: JSON.stringify(jsonrpcError(id, -32602, 'Invalid parameters', { reason: validation.reason })) });
        } else {
          onIncomingMessage(p, t.side, { parts, messageId: String(msg.messageId || crypto.randomUUID()) });
        }
      }
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      t.subscribers.delete(push);
    });
  }

  if (method === 'message/send') {
    const msg = params?.message || {};
    const taskId = String(msg?.taskId || '');
    const t = getTaskById(p, taskId);
    if (!t) return c.json(jsonrpcError(id, -32001, 'Task not found'), 200);
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const validation = validateParts(parts);
    if (!validation.ok) return c.json(jsonrpcError(id, -32602, 'Invalid parameters', { reason: validation.reason }), 200);
    onIncomingMessage(p, t.side, { parts, messageId: String(msg.messageId || crypto.randomUUID()) });
    const historyLength = Number(params?.configuration?.historyLength ?? NaN);
    const snap = taskSnapshot(t, Number.isFinite(historyLength) ? historyLength : undefined);
    return c.json(jsonrpcResult(id, snap), 200);
  }

  if (method === 'tasks/get') {
    const t = getTaskById(p, String(params?.id || ''));
    if (!t) return c.json(jsonrpcError(id, -32001, 'Task not found'), 200);
    const historyLength = Number(params?.historyLength ?? NaN);
    const snap = taskSnapshot(t, Number.isFinite(historyLength) ? historyLength : undefined);
    return c.json(jsonrpcResult(id, snap), 200);
  }

  if (method === 'tasks/resubscribe') {
    const t = getTaskById(p, String(params?.id || ''));
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      if (!t) {
        stream.writeSSE({ data: JSON.stringify(jsonrpcError(id, -32001, 'Task not found')) });
        return;
      }
      const push = (frame: A2AFrame) => {
        const payload = { jsonrpc: '2.0', id, result: frame.result };
        stream.writeSSE({ data: JSON.stringify(payload) });
        logEvent(p, { type: 'a2a-frame', to: asPublicRole(t.side), frame: payload });
      };
      t.subscribers.add(push);
      // initial snapshot
      push({ result: taskSnapshot(t) });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      t.subscribers.delete(push);
    });
  }

  if (method === 'tasks/cancel') {
    const t = getTaskById(p, String(params?.id || ''));
    if (!t) return c.json(jsonrpcError(id, -32001, 'Task not found'), 200);
    setTaskStatus(t, 'canceled');
    return c.json(jsonrpcResult(id, taskSnapshot(t)), 200);
  }

  return c.json(jsonrpcError(id, -32601, 'Method not found', { method }), 200);
});

function onIncomingMessage(p: Pair, from: Role, req: { parts: A2APart[], messageId: string }) {
  const cli = p.initiatorTask!, srv = p.responderTask!;
  const metadata = readExtension(req.parts);
  const finality = metadata?.finality || 'none';

  // Sender perspective
  const fromTask = from === 'initiator' ? cli : srv;
  const toTask   = from === 'initiator' ? srv : cli;

  // Append as 'user' on sender's task
  const msgSender: A2AMessage = {
    role: 'user',
    parts: req.parts,
    messageId: req.messageId,
    taskId: fromTask.id,
    contextId: p.id,
    kind: 'message',
  };
  fromTask.history.push(msgSender);
  logEvent(p, { type: 'incoming-message', from: asPublicRole(from), messageId: req.messageId, finality, parts: req.parts });
  // For non-final messages, the sender should remain input-required to allow continued sending
  if (finality === 'none') {
    fromTask.subscribers.forEach(fn => fn({ result: statusUpdate(fromTask, 'input-required', msgSender) }));
  } else {
    // For 'turn' and 'conversation', show 'working' until turn flip/completion events
    fromTask.subscribers.forEach(fn => fn({ result: statusUpdate(fromTask, 'working', msgSender) }));
  }

  // Mirror as 'agent' on receiver's task
  const msgRecv: A2AMessage = {
    role: 'agent',
    parts: req.parts,
    messageId: req.messageId,
    taskId: toTask.id,
    contextId: p.id,
    kind: 'message',
  };
  toTask.history.push(msgRecv);
  toTask.subscribers.forEach(fn => fn({ result: msgRecv }));
  // For non-final messages, the receiver should be in 'working'
  if (finality === 'none') {
    setTaskStatus(toTask, 'working');
  }
  logEvent(p, { type: 'mirrored-message', to: asPublicRole(toTask.side), messageId: req.messageId });

  if (finality === 'turn') {
    p.turn = (from === 'initiator') ? 'responder' : 'initiator';
    setTaskStatus(toTask, 'input-required');
    logEvent(p, { type: 'finality', kind: 'turn', next: asPublicRole(p.turn) });
  } else if (finality === 'conversation') {
    setTaskStatus(cli, 'completed');
    setTaskStatus(srv, 'completed');
    logEvent(p, { type: 'finality', kind: 'conversation' });
  } else {
    // non-final messages keep receiver in working; do nothing
  }

  // Aggregate summary event for easier reading in Control Plane
  try {
    logEvent(p, {
      type: 'message-summary',
      from: asPublicRole(from),
      received: { messageId: req.messageId, finality, parts: req.parts },
      newTaskSnapshot: {
        initiator: taskToA2A(cli),
        responder: taskToA2A(srv),
      },
    });
  } catch {}
}

function readExtension(parts: A2APart[]): any {
  for (const p of parts) {
    const meta = (p as any)?.metadata || {};
    const block = meta?.["urn:cc:a2a:v1"];
    if (block) return block;
  }
  return null;
}

function newTask(pairId: string, side: Role, id: string): TaskState {
  const t: TaskState = {
    id,
    side,
    pairId,
    status: 'submitted',
    history: [],
    subscribers: new Set(),
  };
  return t;
}

function getTaskById(p: Pair, id: string): TaskState | undefined {
  if (!id) return undefined;
  if (p.initiatorTask?.id === id) return p.initiatorTask;
  if (p.responderTask?.id === id) return p.responderTask;
  return undefined;
}

function setTaskStatus(t: TaskState, state: A2AStatus, message?: A2AMessage) {
  t.status = state;
  const frame = statusUpdate(t, state, message);
  t.subscribers.forEach(fn => fn({ result: frame }));
  try { const pair = mustPair(t.pairId); logEvent(pair, { type: 'status', side: asPublicRole(t.side), state }); } catch {}
}

function taskSnapshot(t: TaskState, historyLength?: number): A2ATask {
  const h = t.history || [];
  const latest = h.length ? h[h.length - 1] : undefined;
  const tail = h.length ? h.slice(0, h.length - 1) : [];
  const sliced = typeof historyLength === 'number' && historyLength >= 0
    ? tail.slice(Math.max(0, tail.length - historyLength))
    : tail;
  return {
    id: t.id,
    contextId: t.pairId,
    kind: 'task',
    status: { state: t.status, ...(latest ? { message: latest } : {}) } as any,
    history: sliced,
    metadata: {}
  } as any;
}

function statusUpdate(t: TaskState, state: A2AStatus, message?: A2AMessage) {
  const terminal = (s: A2AStatus) => ['completed', 'canceled', 'failed', 'rejected'].includes(s);
  return {
    taskId: t.id,
    contextId: t.pairId,
    status: { state, message, timestamp: new Date().toISOString() } as any,
    kind: 'status-update',
    final: terminal(state)
  } as any;
}

function mustPair(id: string): Pair {
  const p = pairs.get(id);
  if (!p) throw new Error('pair not found');
  return p;
}

function shortId(): string {
  const ab = new Uint8Array(5);
  crypto.getRandomValues(ab);
  return Array.from(ab).map(b => b.toString(16).padStart(2,'0')).join('');
}

// Dev server with HTML routes and HMR; delegate /api and /pairs to Hono
function logEvent(p: Pair, ev: any) {
  const payload = { ts: new Date().toISOString(), pairId: p.id, ...ev };
  p.eventLog.forEach(fn => { try { fn(payload); } catch {} });
}

import controlHtml from '../frontend/control/index.html';
import participantHtml from '../frontend/participant/index.html';

const isDev = (Bun.env.NODE_ENV || process.env.NODE_ENV) !== 'production';
const port = Number(process.env.PORT || 3000);

serve({
  port,
  idleTimeout: 240,
  development: isDev ? { hmr: true, console: true } : undefined,
  routes: {
    '/': controlHtml,
    '/control/': controlHtml,
    '/participant/': participantHtml,
  },
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (
      url.pathname === '/api' ||
      url.pathname.startsWith('/api/') ||
      url.pathname === '/pairs' ||
      url.pathname.startsWith('/pairs/')
    ) {
      return (app as any).fetch(req, srv);
    }
    if (url.pathname === '/.well-known/agent-card.json') {
      const card = minimalAgentCard(new URL(req.url).origin);
      return new Response(JSON.stringify(card, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  },
});

// JSON-RPC helpers and validation
function jsonrpcResult(id: any, result: any) {
  return { jsonrpc: '2.0', id, result };
}
function jsonrpcError(id: any, code: number, message: string, data?: any) {
  const err: any = { jsonrpc: '2.0', id, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

function validateParts(parts: A2APart[]): { ok: true } | { ok: false; reason: string } {
  for (const p of parts) {
    if (!p || typeof (p as any).kind !== 'string') return { ok: false, reason: 'part missing kind' };
    if ((p as any).kind === 'file') {
      const f = (p as any).file || {};
      const hasBytes = typeof f.bytes === 'string';
      const hasUri = typeof f.uri === 'string';
      if (hasBytes && hasUri) return { ok: false, reason: 'file part must not include both bytes and uri' };
      if (!hasBytes && !hasUri) return { ok: false, reason: 'file part requires bytes or uri' };
    } else if ((p as any).kind === 'text') {
      if (typeof (p as any).text !== 'string') return { ok: false, reason: 'text part requires text' };
    } else if ((p as any).kind === 'data') {
      if (typeof (p as any).data !== 'object' || (p as any).data === null) return { ok: false, reason: 'data part requires object data' };
    } else {
      return { ok: false, reason: `unsupported part kind ${(p as any).kind}` };
    }
  }
  return { ok: true };
}

function minimalAgentCard(origin: string) {
  return {
    protocolVersion: '0.3.0',
    name: 'FlipProxy Bridge Agent',
    description: 'Pairs two participants and mirrors messages using JSON-RPC and SSE.',
    url: `${origin}/a2a/v1`,
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [
      { url: `${origin}/a2a/v1`, transport: 'JSONRPC' }
    ],
    version: '0.1.0',
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      { id: 'flip-proxy', name: 'Turn-based Mirror', description: 'Mirrors messages between paired participants with turn control.', tags: ['relay', 'chat', 'proxy'] }
    ]
  } as any;
}
