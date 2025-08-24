import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "bun";
import type { A2APart, A2AFrame, A2AMessage, A2AStatus, A2ATask } from "../shared/a2a-types";
import { createLocalStorage } from 'bun-storage';

type Role = 'initiator' | 'responder';
const asPublicRole = (s: Role) => s;

type TaskState = {
  id: string;
  side: Role;
  pairId: string;
  status: A2AStatus;
  history: A2AMessage[];
  subscribers: Set<(frame: A2AFrame)=>void>;
  primaryLogSubscriber?: (frame: A2AFrame)=>void;
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
  eventSeq?: number;
  eventHistory?: Array<{ seq: number; ev: any }>;
  metadata?: any;
  lastActivityMs?: number;
};

const pairs = new Map<string, Pair>();

const app = new Hono();

// --- Persistence (bun-storage) ---
const [localStorage] = createLocalStorage(process.env.FLIPPROXY_DB || './db.sqlite');
const PAIR_INDEX_KEY = 'pair:index';

async function lsGet(key: string): Promise<unknown | null> {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return null;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch { return null; }
}

async function lsSet(key: string, value: unknown): Promise<void> {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

async function lsRemove(key: string): Promise<void> {
  try { localStorage.removeItem(key); } catch {}
}

async function addPairToIndex(id: string) {
  try {
    const idx = (await lsGet(PAIR_INDEX_KEY)) as string[] | null;
    const set = new Set(idx || []);
    set.add(id);
    await lsSet(PAIR_INDEX_KEY, Array.from(set));
  } catch {}
}

async function persistPairMeta(p: Pair) {
  const meta = {
    id: p.id,
    epoch: p.epoch,
    turn: p.turn,
    startingTurn: p.startingTurn,
    eventSeq: typeof p.eventSeq === 'number' ? p.eventSeq : 0,
    lastActivityTs: new Date().toISOString(),
    metadata: p.metadata ?? null,
    tasks: {
      initiator: p.initiatorTask ? { id: p.initiatorTask.id, status: p.initiatorTask.status, history: p.initiatorTask.history } : null,
      responder: p.responderTask ? { id: p.responderTask.id, status: p.responderTask.status, history: p.responderTask.history } : null,
    }
  };
  await lsSet(`pair:meta:${p.id}`, meta);
  p.lastActivityMs = Date.now();
}

async function readPairMeta(id: string): Promise<any | null> {
  return await lsGet(`pair:meta:${id}`);
}

function hydrateTask(pairId: string, side: Role, t: any | null | undefined): TaskState | undefined {
  if (!t) return undefined;
  return {
    id: t.id,
    side,
    pairId,
    status: t.status,
    history: Array.isArray(t.history) ? t.history : [],
    subscribers: new Set(),
  } as TaskState;
}

async function mustPairAsync(id: string): Promise<Pair> {
  const inMem = pairs.get(id);
  if (inMem) return inMem;
  const meta = await readPairMeta(id);
  if (!meta) throw new Error('pair not found');
  const p: Pair = {
    id: meta.id,
    epoch: meta.epoch,
    turn: meta.turn,
    startingTurn: meta.startingTurn ?? 'initiator',
    initiatorTask: hydrateTask(meta.id, 'initiator', meta.tasks?.initiator),
    responderTask: hydrateTask(meta.id, 'responder', meta.tasks?.responder),
    serverEvents: new Set(),
    eventLog: new Set(),
    eventSeq: typeof meta.eventSeq === 'number' ? meta.eventSeq : 0,
    eventHistory: [],
    metadata: meta.metadata ?? null,
    lastActivityMs: meta.lastActivityTs ? Date.parse(meta.lastActivityTs) : Date.now(),
  };
  pairs.set(id, p);
  return p;
}

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
  let metadata: any = undefined;
  try {
    const body = await c.req.json();
    if (body && typeof body.metadata !== 'undefined') {
      if (body.metadata !== null && typeof body.metadata !== 'object') return c.json({ error: { message: 'metadata must be an object' } }, 400);
      const s = JSON.stringify(body.metadata || {});
      if (s.length > 64 * 1024) return c.json({ error: { message: 'metadata too large' } }, 413);
      metadata = body.metadata;
    }
  } catch {}
  const p: Pair = { id: pairId, epoch: 0, turn: 'initiator', startingTurn: 'initiator', serverEvents: new Set(), eventLog: new Set(), eventSeq: 0, eventHistory: [], metadata };
  pairs.set(pairId, p);
  logEvent(p, { type: 'pair-created', pairId, epoch: p.epoch });
  const a2aUrl = `${origin}/api/bridge/${pairId}/a2a`;
  const tasksUrl = `${origin}/pairs/${pairId}/server-events`;
  // persist
  await addPairToIndex(pairId);
  await persistPairMeta(p);
  return c.json({
    pairId,
    // Participant UI links configured with explicit role and endpoints
    initiatorJoinUrl: `${origin}/participant/?role=initiator&a2a=${encodeURIComponent(a2aUrl)}`,
    responderJoinUrl: `${origin}/participant/?role=responder&a2a=${encodeURIComponent(a2aUrl)}&tasks=${encodeURIComponent(tasksUrl)}`,
    serverEventsUrl: tasksUrl
  });
});

// Backchannel: only the responder uses this
app.get('/pairs/:pairId/server-events', async (c) => {
  const pairId = c.req.param('pairId');
  const p = await mustPairAsync(pairId);
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
    if (p.responderTask) {
      push({ type: 'subscribe', pairId, epoch: p.epoch, taskId: p.responderTask.id, turn: p.turn });
      logEvent(p, { type: 'backchannel', action: 'subscribe', epoch: p.epoch, taskId: p.responderTask.id, turn: p.turn });
    }
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    p.serverEvents.delete(push);
    clearInterval(ka);
  });
});

// Alias: control plane event tail
app.get('/pairs/:pairId/events.log', async (c) => {
  const pairId = c.req.param('pairId');
  const p = await mustPairAsync(pairId);
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    const push = (ev: any) => stream.writeSSE({ data: JSON.stringify({ result: ev }) });
    const ka = setInterval(() => {
      try { stream.writeSSE({ event: 'ping', data: String(Date.now()) }); } catch {}
    }, 15000);
    // Send backlog if requested
    try {
      const url = new URL(c.req.url);
      const sinceParam = url.searchParams.get('since');
      const since = sinceParam ? Number(sinceParam) : -1;
      const hist = p.eventHistory || [];
      if (Number.isFinite(since)) {
        for (const row of hist) {
          if (row.seq > since) push(row.ev);
        }
      }
    } catch {}
    p.eventLog.add(push);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    p.eventLog.delete(push);
    clearInterval(ka);
  });
});

app.post('/pairs/:pairId/reset', async (c) => {
  const pairId = c.req.param('pairId');
  const { type } = await safeJson(c);
  const p = await mustPairAsync(pairId);
  // Only hard reset is supported
    // hard: retain same pair, clear log, cancel tasks, advance epoch, and signal unsubscribe
    logEvent(p, { type: 'reset-start', reason: 'hard', prevEpoch: p.epoch, nextEpoch: p.epoch + 1 });
    // clear server-side event history (keep seq monotonic)
    p.eventHistory = [];
    // notify responder to unsubscribe current epoch
    if (p.responderTask) {
      const ev = { type: 'unsubscribe', pairId, epoch: p.epoch };
      p.serverEvents.forEach(fn => fn(ev));
      logEvent(p, { type: 'backchannel', action: 'unsubscribe', epoch: p.epoch });
    }
    // cancel existing tasks (participants receive canceled if subscribed)
    if (p.initiatorTask) setTaskStatus(p.initiatorTask, 'canceled');
    if (p.responderTask) setTaskStatus(p.responderTask, 'canceled');
    try { logEvent(p, { type: 'state', states: { initiator: p.initiatorTask?.status || 'canceled', responder: p.responderTask?.status || 'canceled' } }); } catch {}
    // bump epoch and drop task refs; next initiator send will start a new epoch
    p.epoch += 1;
    p.initiatorTask = undefined;
    p.responderTask = undefined;
    // mark completion of reset sequence for control-plane clarity
    logEvent(p, { type: 'reset-complete', epoch: p.epoch });
    try { persistPairMeta(p); } catch {}
    return c.json({ ok: true, epoch: p.epoch });
  
});

// A2A JSON-RPC bridge (single endpoint)
app.post('/api/bridge/:pairId/a2a', async (c) => {
  const pairId = c.req.param('pairId');
  const p = await mustPairAsync(pairId);
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
          logEvent(p, { type: 'epoch-begin', epoch: p.epoch });
          // tell responder to subscribe
          {
            const ev = { type:'subscribe', pairId, epoch: p.epoch, taskId: p.responderTask!.id, turn: p.turn };
            p.serverEvents.forEach(fn => fn(ev));
            logEvent(p, { type: 'backchannel', action: 'subscribe', epoch: p.epoch, taskId: p.responderTask!.id, turn: p.turn });
          }
          try { persistPairMeta(p); } catch {}
        }
        task = p.initiatorTask;
      }
      const t = task!;
      const push = (frame: A2AFrame) => {
        const payload = { jsonrpc: '2.0', id, result: frame.result };
        stream.writeSSE({ data: JSON.stringify(payload) });
        // a2a-frame intentionally not logged in concise mode
      };
      t.subscribers.add(push);
      if (!t.primaryLogSubscriber) t.primaryLogSubscriber = push;
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
      if (t.primaryLogSubscriber === push) {
        // promote any remaining subscriber as primary
        const next = t.subscribers.values().next();
        t.primaryLogSubscriber = next && !next.done ? next.value : undefined;
      }
    });
  }

  if (method === 'message/send') {
    const msg = params?.message || {};
    let taskId = String(msg?.taskId || '');
    let t = getTaskById(p, taskId);
    if (!t) {
      // If no task provided, treat as new epoch from initiator and create tasks
      // This mirrors the behavior of message/stream when launched without a taskId
      p.epoch += 1;
      p.turn = p.startingTurn || 'initiator';
      p.initiatorTask = newTask(pairId, 'initiator', `init:${pairId}#${p.epoch}`);
      p.responderTask = newTask(pairId, 'responder', `resp:${pairId}#${p.epoch}`);
      logEvent(p, { type: 'epoch-begin', epoch: p.epoch });
      // tell responder to subscribe
      {
        const ev = { type:'subscribe', pairId, epoch: p.epoch, taskId: p.responderTask!.id, turn: p.turn };
        p.serverEvents.forEach(fn => fn(ev));
        logEvent(p, { type: 'backchannel', action: 'subscribe', epoch: p.epoch, taskId: p.responderTask!.id, turn: p.turn });
      }
      try { persistPairMeta(p); } catch {}
      t = p.initiatorTask;
      taskId = t!.id;
    }
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const validation = validateParts(parts);
    if (!validation.ok) return c.json(jsonrpcError(id, -32602, 'Invalid parameters', { reason: validation.reason }), 200);
    onIncomingMessage(p, t!.side, { parts, messageId: String(msg.messageId || crypto.randomUUID()) });
    const historyLength = Number(params?.configuration?.historyLength ?? NaN);
    const snap = taskSnapshot(t!, Number.isFinite(historyLength) ? historyLength : undefined);
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
        // a2a-frame intentionally not logged in concise mode
      };
      t.subscribers.add(push);
      if (!t.primaryLogSubscriber) t.primaryLogSubscriber = push;
      // initial snapshot
      push({ result: taskSnapshot(t) });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      t.subscribers.delete(push);
      if (t.primaryLogSubscriber === push) {
        const next = t.subscribers.values().next();
        t.primaryLogSubscriber = next && !next.done ? next.value : undefined;
      }
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
  // (concise log) do not emit separate incoming-message
  // For non-final messages, the sender should remain input-required to allow continued sending
  if (finality === 'none') {
    // Update state and notify
    setTaskStatus(fromTask, 'input-required', msgSender);
  } else {
    // For 'turn' and 'conversation', show 'working' until turn flip/completion events
    setTaskStatus(fromTask, 'working', msgSender);
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
  // (concise log) do not emit separate mirrored-message

  if (finality === 'turn') {
    p.turn = (from === 'initiator') ? 'responder' : 'initiator';
    setTaskStatus(toTask, 'input-required');
    // (concise log) nextTurn included in 'message' event below
  } else if (finality === 'conversation') {
    setTaskStatus(cli, 'completed');
    setTaskStatus(srv, 'completed');
    // (concise log) conversation captured in message.effects (terminal)
  } else {
    // non-final messages keep receiver in working; do nothing
  }

  // Combined state snapshot (atomic both sides)
  try {
    logEvent(p, { type: 'state', states: { initiator: cli.status, responder: srv.status } });
  } catch {}

  // Concise message event for Control Plane
  try {
    const text = (req.parts || []).filter((pp:any)=>pp?.kind==='text').map((pp:any)=>pp.text).filter((t:any)=>typeof t==='string').join('\n');
    const msg:any = {
      type: 'message',
      from: asPublicRole(from),
      finality,
      messageId: req.messageId,
      text,
      effects: {
        initiator: { state: cli.status },
        responder: { state: srv.status }
      }
    };
    if (finality === 'turn') msg.nextTurn = asPublicRole(p.turn);
    logEvent(p, msg);
  } catch {}
  try { persistPairMeta(p); } catch {}
}

function readExtension(parts: A2APart[]): any {
  for (const p of parts) {
    // All parts have optional metadata in our A2APart type
    const meta = (p && (p as { metadata?: Record<string, any> }).metadata) || {};
    const block = (meta as Record<string, any>)?.["https://chitchat.fhir.me/a2a-ext"];
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
  try { const pair = mustPair(t.pairId); persistPairMeta(pair); } catch {}
}

function taskSnapshot(t: TaskState, historyLength?: number): A2ATask {
  const h = t.history || [];
  const latest = h.length ? h[h.length - 1] : undefined;
  const tail = h.length ? h.slice(0, h.length - 1) : [];
  const sliced = typeof historyLength === 'number' && historyLength >= 0
    ? tail.slice(Math.max(0, tail.length - historyLength))
    : tail;
  const status: { state: A2AStatus; message?: A2AMessage } = latest ? { state: t.status, message: latest } : { state: t.status };
  return {
    id: t.id,
    contextId: t.pairId,
    kind: 'task',
    status,
    history: sliced,
    metadata: {}
  };
}

function statusUpdate(t: TaskState, state: A2AStatus, message?: A2AMessage): import('../shared/a2a-types').A2AStatusUpdate {
  const terminal = (s: A2AStatus) => ['completed', 'canceled', 'failed', 'rejected'].includes(s);
  return {
    taskId: t.id,
    contextId: t.pairId,
    status: { state, message },
    kind: 'status-update',
    final: terminal(state)
  };
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
const EVENT_LOG_CAPACITY = 1000;
function logEvent(p: Pair, ev: any) {
  // assign sequence and timestamp
  if (typeof p.eventSeq !== 'number') p.eventSeq = 0;
  if (!Array.isArray(p.eventHistory)) p.eventHistory = [];
  const seq = ++p.eventSeq;
  const payload = { ts: new Date().toISOString(), pairId: p.id, seq, ...ev };
  // append to history and trim to capacity
  p.eventHistory.push({ seq, ev: payload });
  const over = (p.eventHistory.length || 0) - EVENT_LOG_CAPACITY;
  if (over > 0) p.eventHistory.splice(0, over);
  // live fanout
  p.eventLog.forEach(fn => { try { fn(payload); } catch {} });
  // persist monotonic seq + activity
  try { persistPairMeta(p); } catch {}
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
      return app.fetch(req);
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
    if (!p || typeof p.kind !== 'string') return { ok: false, reason: 'part missing kind' };
    if (p.kind === 'file') {
      const f = p.file;
      const hasBytes = ('bytes' in f) && typeof (f as {bytes?: unknown}).bytes === 'string';
      const hasUri = ('uri' in f) && typeof (f as {uri?: unknown}).uri === 'string';
      if (hasBytes && hasUri) return { ok: false, reason: 'file part must not include both bytes and uri' };
      if (!hasBytes && !hasUri) return { ok: false, reason: 'file part requires bytes or uri' };
    } else if (p.kind === 'text') {
      if (typeof p.text !== 'string') return { ok: false, reason: 'text part requires text' };
    } else if (p.kind === 'data') {
      if (typeof p.data !== 'object' || p.data === null) return { ok: false, reason: 'data part requires object data' };
    } else {
      return { ok: false, reason: `unsupported part kind` };
    }
  }
  return { ok: true };
}

function minimalAgentCard(origin: string): any {
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
  };
}

// --- Watchdog for TTL eviction ---
const MEMORY_TTL_MS = Number(process.env.PAIR_TTL_MEMORY_MS || 30 * 60 * 1000);
const STORAGE_TTL_MS = Number(process.env.PAIR_TTL_STORAGE_MS || 48 * 60 * 60 * 1000);

function hasActiveConnections(p: Pair): boolean {
  const taskActive = (p.initiatorTask?.subscribers?.size || 0) + (p.responderTask?.subscribers?.size || 0) > 0;
  const logsActive = (p.serverEvents?.size || 0) + (p.eventLog?.size || 0) > 0;
  return taskActive || logsActive;
}

async function runWatchdog() {
  const now = Date.now();
  // Evict from memory
  for (const [id, p] of pairs) {
    const last = p.lastActivityMs || 0;
    if (!hasActiveConnections(p) && last && now - last > MEMORY_TTL_MS) {
      pairs.delete(id);
    }
  }
  // Evict from storage
  try {
    const idx = (await lsGet(PAIR_INDEX_KEY)) as string[] | null;
    const list = Array.isArray(idx) ? idx.slice() : [];
    const keep: string[] = [];
    for (const id of list) {
      const inMem = pairs.get(id);
      if (inMem && hasActiveConnections(inMem)) { keep.push(id); continue; }
      const meta = await readPairMeta(id);
      if (!meta) continue;
      const lastTs = meta.lastActivityTs ? Date.parse(meta.lastActivityTs) : 0;
      if (now - lastTs > STORAGE_TTL_MS) {
        await lsRemove(`pair:meta:${id}`);
        // do not push id to keep
      } else {
        keep.push(id);
      }
    }
    await lsSet(PAIR_INDEX_KEY, keep);
  } catch {}
}

setInterval(runWatchdog, 60_000);
// Pair metadata endpoints
app.get('/api/pairs/:pairId/metadata', async (c) => {
  const pairId = c.req.param('pairId');
  // prefer persisted copy
  const stored = await readPairMeta(pairId);
  if (stored && Object.prototype.hasOwnProperty.call(stored, 'metadata')) return c.json({ metadata: stored.metadata });
  // fallback to memory
  const p = pairs.get(pairId);
  return c.json({ metadata: p?.metadata ?? null });
});
