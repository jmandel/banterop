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
  const accept = (c.req.header('accept') || '').toLowerCase();
  const body = await safeJson(c);
  const method = String(body?.method || '');
  const id = body?.id ?? null;
  const params = body?.params || {};

  if (method === 'message/stream') {
    const msg = params?.message || {};
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
        stream.writeSSE({ data: JSON.stringify(frame) });
        logEvent(p, { type: 'a2a-frame', to: asPublicRole(t.side), frame });
      };
      t.subscribers.add(push);
      // Let caller know the task snapshot first
      push({ result: taskToA2A(t) });
      // If a message payload was provided, record & reflect
      const parts = Array.isArray(msg.parts) ? msg.parts : [];
      if (parts.length) {
        onIncomingMessage(p, t.side, { parts, messageId: String(msg.messageId || crypto.randomUUID()) });
      }
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      t.subscribers.delete(push);
    });
  }

  if (method === 'message/send') {
    const msg = params?.message || {};
    const taskId = String(msg?.taskId || '');
    const t = getTaskById(p, taskId);
    if (!t) return c.json({ error: { message: 'task not found' } }, 404);
    onIncomingMessage(p, t.side, { parts: msg.parts || [], messageId: String(msg.messageId || crypto.randomUUID()) });
    return c.json({ ok: true });
  }

  if (method === 'tasks/get') {
    const t = getTaskById(p, String(params?.id || ''));
    if (!t) return c.json({ error: { message: 'task not found' } }, 404);
    return c.json({ result: taskToA2A(t) });
  }

  if (method === 'tasks/resubscribe') {
    const t = getTaskById(p, String(params?.id || ''));
    if (!t) return c.text('not found', 404);
    return streamSSE(c, async (stream) => {
      const push = (frame: A2AFrame) => {
        stream.writeSSE({ data: JSON.stringify(frame) });
        logEvent(p, { type: 'a2a-frame', to: asPublicRole(t.side), frame });
      };
      t.subscribers.add(push);
      // initial snapshot
      push({ result: taskToA2A(t) });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      t.subscribers.delete(push);
    });
  }

  if (method === 'tasks/cancel') {
    const t = getTaskById(p, String(params?.id || ''));
    if (!t) return c.json({ error: { message: 'task not found' } }, 404);
    setTaskStatus(t, 'canceled');
    return c.json({ ok: true });
  }

  return c.json({ error: { message: `unknown method ${method}` } }, 400);
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

function taskToA2A(t: TaskState): A2ATask {
  return {
    id: t.id,
    contextId: t.pairId,
    kind: 'task',
    status: { state: t.status },
    history: [...t.history],
    metadata: {}
  };
}

function statusUpdate(t: TaskState, state: A2AStatus, message?: A2AMessage) {
  return {
    taskId: t.id,
    contextId: t.pairId,
    status: { state, message },
    kind: 'status-update'
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
    return new Response('Not Found', { status: 404 });
  },
});
