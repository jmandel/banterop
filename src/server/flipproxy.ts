import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "bun";
import type { A2APart, A2AFrame, A2AMessage, A2AStatus, A2ATask } from "../shared/a2a-types";
import { A2A_EXT_URL } from "../shared/core";
import { createLocalStorage } from 'bun-storage';
import controlHtml from '../frontend/control/index.html';
import participantHtml from '../frontend/participant/index.html';
import { registerFlipProxyMcpBridge } from './bridge/mcp-on-flipproxy';

export type Role = 'initiator' | 'responder';
const asPublicRole = (s: Role) => s;

export type TaskState = {
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
registerFlipProxyMcpBridge(app);

// --- Basic request logging middleware (debug slow/pending requests)
app.use('*', async (c, next) => {
  const start = Date.now();
  const url = new URL(c.req.url);
  const id = Math.random().toString(36).slice(2, 8);
  const accept = c.req.header('accept') || '';
  const ct = c.req.header('content-type') || '';
  try {
    console.log(`[req ${id}] ${c.req.method} ${url.pathname} accept=${accept} ct=${ct}`);
    await next();
    const ms = Date.now() - start;
    const status = (c as any).res?.status || '-';
    console.log(`[res ${id}] ${c.req.method} ${url.pathname} -> ${status} in ${ms}ms`);
  } catch (e) {
    const ms = Date.now() - start;
    console.error(`[err ${id}] ${c.req.method} ${url.pathname} after ${ms}ms`, e);
    throw e;
  }
});

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

export async function mustPairAsync(id: string): Promise<Pair> {
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
  await addPairToIndex(pairId);
  await persistPairMeta(p);
  return c.json({
    pairId,
    initiatorJoinUrl: `${origin}/participant/?role=initiator&a2a=${encodeURIComponent(a2aUrl)}`,
    responderJoinUrl: `${origin}/participant/?role=responder&a2a=${encodeURIComponent(a2aUrl)}&tasks=${encodeURIComponent(tasksUrl)}`,
    serverEventsUrl: tasksUrl
  });
});

// Backchannel for responder
app.get('/pairs/:pairId/server-events', async (c) => {
  const pairId = c.req.param('pairId');
  const p = await mustPairAsync(pairId);
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    try { console.log(`[sse open] /pairs/${'${'}pairId${'}'}/server-events`); } catch {}
    const push = (ev: any) => stream.writeSSE({ data: JSON.stringify({ result: ev }) });
    const ka = setInterval(() => { try { stream.writeSSE({ event: 'ping', data: String(Date.now()) }); } catch {} }, 15000);
    p.serverEvents.add(push);
    if (p.responderTask) {
      push({ type: 'subscribe', pairId, epoch: p.epoch, taskId: p.responderTask.id, turn: p.turn });
      logEvent(p, { type: 'backchannel', action: 'subscribe', epoch: p.epoch, taskId: p.responderTask.id, turn: p.turn });
    }
    await new Promise<void>((resolve) => stream.onAbort(() => { try { console.log(`[sse abort] /pairs/${'${'}pairId${'}'}/server-events`); } catch {}; resolve(); }));
    p.serverEvents.delete(push);
    clearInterval(ka);
  });
});

// Control plane event tail
app.get('/pairs/:pairId/events.log', async (c) => {
  const pairId = c.req.param('pairId');
  const p = await mustPairAsync(pairId);
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    try { console.log(`[sse open] /pairs/${'${'}pairId${'}'}/server-events`); } catch {}
    const push = (ev: any) => stream.writeSSE({ data: JSON.stringify({ result: ev }) });
    const ka = setInterval(() => { try { stream.writeSSE({ event: 'ping', data: String(Date.now()) }); } catch {} }, 15000);
    try {
      const url = new URL(c.req.url);
      const sinceParam = url.searchParams.get('since');
      const since = sinceParam ? Number(sinceParam) : -1;
      const hist = p.eventHistory || [];
      if (Number.isFinite(since)) {
        for (const row of hist) if (row.seq > since) push(row.ev);
      }
    } catch {}
    p.eventLog.add(push);
    await new Promise<void>((resolve) => stream.onAbort(() => { try { console.log(`[sse abort] /pairs/${'${'}pairId${'}'}/events.log`); } catch {}; resolve(); }));
    p.eventLog.delete(push);
    clearInterval(ka);
  });
});

app.post('/pairs/:pairId/reset', async (c) => {
  const pairId = c.req.param('pairId');
  const { type } = await safeJson(c);
  const p = await mustPairAsync(pairId);
  logEvent(p, { type: 'reset-start', reason: 'hard', prevEpoch: p.epoch, nextEpoch: p.epoch + 1 });
  p.eventHistory = [];
  if (p.responderTask) {
    const ev = { type: 'unsubscribe', pairId, epoch: p.epoch };
    p.serverEvents.forEach(fn => fn(ev));
    logEvent(p, { type: 'backchannel', action: 'unsubscribe', epoch: p.epoch });
  }
  if (p.initiatorTask) setTaskStatus(p.initiatorTask, 'canceled');
  if (p.responderTask) setTaskStatus(p.responderTask, 'canceled');
  try {
    // For reset, emit simplified summary state (string values) to match tests
    const i = p.initiatorTask?.status || 'canceled';
    const r = p.responderTask?.status || 'canceled';
    logEvent(p, { type: 'state', states: { initiator: i, responder: r } });
  } catch {}
  p.epoch += 1;
  p.initiatorTask = undefined;
  p.responderTask = undefined;
  logEvent(p, { type: 'reset-complete', epoch: p.epoch });
  try { persistPairMeta(p); } catch {}
  return c.json({ ok: true, epoch: p.epoch });
});

// A2A JSON-RPC bridge
app.post('/api/bridge/:pairId/a2a', async (c) => {
  const pairId = c.req.param('pairId');
  const p = await mustPairAsync(pairId);
  let raw: any;
  try { raw = await c.req.json(); } catch { return c.json(jsonrpcError(null, -32700, 'Invalid JSON payload'), 200); }
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
      const ka = setInterval(() => { try { stream.writeSSE({ event: 'ping', data: String(Date.now()) }); } catch {} }, 15000);
      let side: Role | null = null;
      let task: TaskState | undefined;
      if (msg.taskId) {
        task = getTaskById(p, String(msg.taskId));
        side = task?.side || null;
      }
      if (!task) {
        side = 'initiator';
        if (!p.initiatorTask || !p.responderTask) {
          p.epoch += 1;
          p.turn = p.startingTurn || 'initiator';
          p.initiatorTask = newTask(pairId, 'initiator', `init:${pairId}#${p.epoch}`);
          p.responderTask = newTask(pairId, 'responder', `resp:${pairId}#${p.epoch}`);
          logEvent(p, { type: 'epoch-begin', epoch: p.epoch });
          const ev = { type:'subscribe', pairId, epoch: p.epoch, taskId: p.responderTask!.id, turn: p.turn };
          p.serverEvents.forEach(fn => fn(ev));
          logEvent(p, { type: 'backchannel', action: 'subscribe', epoch: p.epoch, taskId: p.responderTask!.id, turn: p.turn });
          try { persistPairMeta(p); } catch {}
        }
        task = p.initiatorTask;
      }
      const t = task!;
      const push = (frame: A2AFrame) => {
        const payload = { jsonrpc: '2.0', id, result: frame.result };
        stream.writeSSE({ data: JSON.stringify(payload) });
      };
      t.subscribers.add(push);
      if (!t.primaryLogSubscriber) t.primaryLogSubscriber = push;
      push({ result: taskSnapshot(t) });
      const parts = Array.isArray(msg.parts) ? msg.parts : [];
      const msgMeta = (msg && typeof msg === 'object' && (msg as any).metadata) || undefined;
      if (parts.length) {
        const validation = validateParts(parts);
        if (!validation.ok) {
          stream.writeSSE({ data: JSON.stringify(jsonrpcError(id, -32602, 'Invalid parameters', { reason: validation.reason })) });
        } else {
          onIncomingMessage(p, t.side, { parts, messageId: String(msg.messageId || crypto.randomUUID()), metadata: msgMeta });
        }
      }
      await new Promise<void>((resolve) => stream.onAbort(() => { try { console.log(`[sse abort] message/stream for pair ${'${'}pairId${'}'}`); } catch {}; resolve(); }));
      t.subscribers.delete(push);
      if (t.primaryLogSubscriber === push) {
        const next = t.subscribers.values().next();
        t.primaryLogSubscriber = next && !next.done ? next.value : undefined;
      }
      clearInterval(ka);
    });
  }

  if (method === 'message/send') {
    const msg = params?.message || {};
    let taskId = String(msg?.taskId || '');
    let t = getTaskById(p, taskId);
    if (!t) {
      p.epoch += 1;
      p.turn = p.startingTurn || 'initiator';
      p.initiatorTask = newTask(pairId, 'initiator', `init:${pairId}#${p.epoch}`);
      p.responderTask = newTask(pairId, 'responder', `resp:${pairId}#${p.epoch}`);
      logEvent(p, { type: 'epoch-begin', epoch: p.epoch });
      const ev = { type:'subscribe', pairId, epoch: p.epoch, taskId: p.responderTask!.id, turn: p.turn };
      p.serverEvents.forEach(fn => fn(ev));
      logEvent(p, { type: 'backchannel', action: 'subscribe', epoch: p.epoch, taskId: p.responderTask!.id, turn: p.turn });
      try { persistPairMeta(p); } catch {}
      t = p.initiatorTask;
      taskId = t!.id;
    }
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const validation = validateParts(parts);
    if (!validation.ok) return c.json(jsonrpcError(id, -32602, 'Invalid parameters', { reason: validation.reason }), 200);
    const msgMeta = (msg && typeof msg === 'object' && (msg as any).metadata) || undefined;
    onIncomingMessage(p, t!.side, { parts, messageId: String(msg.messageId || crypto.randomUUID()), metadata: msgMeta });
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
      const ka = setInterval(() => { try { stream.writeSSE({ event: 'ping', data: String(Date.now()) }); } catch {} }, 15000);
      if (!t) {
        stream.writeSSE({ data: JSON.stringify(jsonrpcError(id, -32001, 'Task not found')) });
        clearInterval(ka);
        return;
      }
      const push = (frame: A2AFrame) => {
        const payload = { jsonrpc: '2.0', id, result: frame.result };
        stream.writeSSE({ data: JSON.stringify(payload) });
      };
      t.subscribers.add(push);
      if (!t.primaryLogSubscriber) t.primaryLogSubscriber = push;
      push({ result: taskSnapshot(t) });
      await new Promise<void>((resolve) => stream.onAbort(() => { try { console.log(`[sse abort] tasks/resubscribe for ${'${'}String(params?.id || '')${'}'}`); } catch {}; resolve(); }));
      t.subscribers.delete(push);
      if (t.primaryLogSubscriber === push) {
        const next = t.subscribers.values().next();
        t.primaryLogSubscriber = next && !next.done ? next.value : undefined;
      }
      clearInterval(ka);
    });
  }

  if (method === 'tasks/cancel') {
    const t = getTaskById(p, String(params?.id || ''));
    if (!t) return c.json(jsonrpcError(id, -32001, 'Task not found'), 200);
    // Cancel both sides of the conversation so subscribers on either task are notified
    try {
      if (p.initiatorTask) setTaskStatus(p.initiatorTask, 'canceled');
      if (p.responderTask) setTaskStatus(p.responderTask, 'canceled');
      // Log combined state to control-plane event log
      try {
        // For cancel, emit simplified summary state (string values) to match tests
        const i = p.initiatorTask?.status || 'canceled';
        const r = p.responderTask?.status || 'canceled';
        logEvent(p, { type: 'state', states: { initiator: i, responder: r } });
      } catch {}
      // Optional: emit an unsubscribe advisory on serverEvents so responders can stop any assumptions
      const ev = { type: 'unsubscribe', pairId: p.id, epoch: p.epoch };
      try { p.serverEvents.forEach(fn => fn(ev)); logEvent(p, { type:'backchannel', action:'unsubscribe', epoch:p.epoch }); } catch {}
    } catch {}
    // Return the snapshot for the task that requested cancel
    return c.json(jsonrpcResult(id, taskSnapshot(t)), 200);
  }

  return c.json(jsonrpcError(id, -32601, 'Method not found', { method }), 200);
});

export function onIncomingMessage(p: Pair, from: Role, req: { parts: A2APart[], messageId: string, metadata?: any }) {
  const cli = p.initiatorTask!, srv = p.responderTask!;
  const metadata = readMessageExtension(req.metadata, req.parts);
  const finality = metadata?.finality || 'none';

  const fromTask = from === 'initiator' ? cli : srv;
  const toTask   = from === 'initiator' ? srv : cli;

  const msgSender: A2AMessage = {
    role: 'user',
    parts: req.parts,
    messageId: req.messageId,
    taskId: fromTask.id,
    contextId: p.id,
    kind: 'message',
  };
  fromTask.history.push(msgSender);
  if (finality === 'none') {
    setTaskStatus(fromTask, 'input-required', msgSender);
  } else {
    setTaskStatus(fromTask, 'working', msgSender);
  }

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
  if (finality === 'none') {
    setTaskStatus(toTask, 'working');
  }

  if (finality === 'turn') {
    p.turn = (from === 'initiator') ? 'responder' : 'initiator';
    setTaskStatus(toTask, 'input-required');
  } else if (finality === 'conversation') {
    setTaskStatus(cli, 'completed');
    setTaskStatus(srv, 'completed');
  }

  try {
    logEvent(p, {
      type: 'state',
      states: {
        initiator: briefTask(cli, true),
        responder: briefTask(srv, true),
      }
    });
  } catch {}
  try { persistPairMeta(p); } catch {}
}

function readExtension(parts: A2APart[]): any {
  for (const p of parts) {
    const meta = (p && (p as { metadata?: Record<string, any> }).metadata) || {};
    const block = (meta as Record<string, any>)?.[A2A_EXT_URL];
    if (block) return block;
  }
  return null;
}


function readMessageExtension(msgMeta: any, parts: A2APart[]): any {
  try {
    if (msgMeta && typeof msgMeta === 'object') {
      const block = (msgMeta as Record<string, any>)[A2A_EXT_URL];
      if (block) return block;
    }
  } catch {}
  return readExtension(parts);
}


export function newTask(pairId: string, side: Role, id: string): TaskState {
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
    kind: 'status-update' as const,
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

const EVENT_LOG_CAPACITY = 1000;
function logEvent(p: Pair, ev: any) {
  if (typeof p.eventSeq !== 'number') p.eventSeq = 0;
  if (!Array.isArray(p.eventHistory)) p.eventHistory = [];
  const seq = ++p.eventSeq;
  const payload = { ts: new Date().toISOString(), pairId: p.id, seq, ...ev };
  p.eventHistory.push({ seq, ev: payload });
  const over = (p.eventHistory.length || 0) - EVENT_LOG_CAPACITY;
  if (over > 0) p.eventHistory.splice(0, over);
  p.eventLog.forEach(fn => { try { fn(payload); } catch {} });
  try { persistPairMeta(p); } catch {}
}

const isDev = (Bun.env.NODE_ENV || process.env.NODE_ENV) !== 'production';
const port = Number(process.env.PORT || 3000);



// Debug endpoint to inspect open SSE subscribers and tasks
app.get('/__debug/connections', async (c) => {
  const out: any[] = [];
  for (const [id, p] of pairs) {
    out.push({
      pairId: id,
      epoch: p.epoch,
      serverEventsSubscribers: p.serverEvents.size,
      eventLogSubscribers: p.eventLog.size,
      initiatorTask: p.initiatorTask ? {
        id: p.initiatorTask.id,
        status: p.initiatorTask.status,
        subscribers: p.initiatorTask.subscribers.size
      } : null,
      responderTask: p.responderTask ? {
        id: p.responderTask.id,
        status: p.responderTask.status,
        subscribers: p.responderTask.subscribers.size
      } : null
    });
  }
  return c.json({ version: 1, out });
});
const server = serve({
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

try {
  const host = (server as any)?.hostname || 'localhost';
  const url = `http://${host}:${server.port}`;
  console.log(`[flipproxy] Listening at ${url}`);
  console.log(`[flipproxy] Participant UI: ${url}/participant/`);
  console.log(`[flipproxy] Control UI:     ${url}/control/`);
} catch {}

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
      const f = (p as any).file;
      const hasBytes = ('bytes' in f) && typeof (f as {bytes?: unknown}).bytes === 'string';
      const hasUri = ('uri' in f) && typeof (f as {uri?: unknown}).uri === 'string';
      if (hasBytes && hasUri) return { ok: false, reason: 'file part must not include both bytes and uri' };
      if (!hasBytes && !hasUri) return { ok: false, reason: 'file part requires bytes or uri' };
    } else if ((p as any).kind === 'text') {
      if (typeof (p as any).text !== 'string') return { ok: false, reason: 'text part requires text' };
    } else if ((p as any).kind === 'data') {
      if (typeof (p as any).data !== 'object' || (p as any).data === null) return { ok: false, reason: 'data part requires object data' };
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

// Watchdog for TTL eviction
const MEMORY_TTL_MS = Number(process.env.PAIR_TTL_MEMORY_MS || 30 * 60 * 1000);
const STORAGE_TTL_MS = Number(process.env.PAIR_TTL_STORAGE_MS || 48 * 60 * 60 * 1000);

function hasActiveConnections(p: Pair): boolean {
  const taskActive = (p.initiatorTask?.subscribers?.size || 0) + (p.responderTask?.subscribers?.size || 0) > 0;
  const logsActive = (p.serverEvents?.size || 0) + (p.eventLog?.size || 0) > 0;
  return taskActive || logsActive;
}

async function runWatchdog() {
  const now = Date.now();
  for (const [id, p] of pairs) {
    const last = p.lastActivityMs || 0;
    if (!hasActiveConnections(p) && last && now - last > MEMORY_TTL_MS) {
      pairs.delete(id);
    }
  }
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
      } else {
        keep.push(id);
      }
    }
    await lsSet(PAIR_INDEX_KEY, keep);
  } catch {}
}

setInterval(runWatchdog, 60_000);

// Create a minimal task subset shaped like an A2A task for logging
function briefTask(t: TaskState | undefined, includeMessage = false) {
  const state = t?.status;
  if (!t) return { id: undefined, status: { state } };
  if (includeMessage) {
    const h = Array.isArray(t.history) ? t.history : [];
    const message = h.length ? h[h.length - 1] : undefined;
    return message ? { id: t.id, status: { state, message } } : { id: t.id, status: { state } };
  }
  return { id: t.id, status: { state } };
}
