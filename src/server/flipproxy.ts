import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "bun";
import type { A2APart, A2AFrame, A2AMessage, A2AStatus, A2ATask } from "../shared/a2a-types";

type Role = 'client' | 'server';

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
  clientTask?: TaskState;
  serverTask?: TaskState;
  serverEvents: Set<(ev:any)=>void>;
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
  const p: Pair = { id: pairId, epoch: 0, turn: 'client', startingTurn: 'client', serverEvents: new Set() };
  pairs.set(pairId, p);
  return c.json({
    pairId,
    // Participant UI links with explicit role
    aJoinUrl: `${origin}/participant/?pairId=${pairId}&role=a`,
    bJoinUrl: `${origin}/participant/?pairId=${pairId}&role=b`,
    serverEventsUrl: `${origin}/pairs/${pairId}/server-events`
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
    if (p.serverTask) push({ type: 'subscribe', pairId, epoch: p.epoch, taskId: p.serverTask.id, turn: (p.turn === 'client' ? 'a' : 'b') });
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
    p.serverEvents.add(push);
    if (p.serverTask) push({ type: 'subscribe', pairId, epoch: p.epoch, taskId: p.serverTask.id, turn: (p.turn === 'client' ? 'a' : 'b') });
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    p.serverEvents.delete(push);
    clearInterval(ka);
  });
});

app.post('/pairs/:pairId/reset', async (c) => {
  const pairId = c.req.param('pairId');
  const { type } = await safeJson(c);
  const p = mustPair(pairId);
  if (type === 'soft') {
    // notify server to unsubscribe old
    if (p.serverTask) p.serverEvents.forEach(fn => fn({ type: 'unsubscribe', pairId, epoch: p.epoch }));
    // cancel tasks and bump epoch
    if (p.clientTask) setTaskStatus(p.clientTask, 'canceled');
    if (p.serverTask) setTaskStatus(p.serverTask, 'canceled');
    p.epoch += 1;
    p.turn = p.startingTurn || 'client';
    p.clientTask = undefined;
    p.serverTask = undefined;
    // create fresh tasks for next epoch (ids allocated now)
    const cli = newTask(pairId, 'client', `cli:${pairId}#${p.epoch}`);
    const srv = newTask(pairId, 'server', `srv:${pairId}#${p.epoch}`);
    p.clientTask = cli; p.serverTask = srv;
    // prompt server to subscribe new
    p.serverEvents.forEach(fn => fn({ type: 'subscribe', pairId, epoch: p.epoch, taskId: srv.id, turn: (p.turn === 'client' ? 'a' : 'b') }));
    return c.json({ ok: true, epoch: p.epoch });
  } else {
    // hard: redirect (new pair)
    const origin = new URL(c.req.url).origin;
    const np = shortId();
    const newPair: Pair = { id: np, epoch: 0, turn: 'client', startingTurn: 'client', serverEvents: new Set() };
    pairs.set(np, newPair);
    // cancel existing
    if (p.clientTask) setTaskStatus(p.clientTask, 'canceled');
    if (p.serverTask) setTaskStatus(p.serverTask, 'canceled');
    // notify redirect
    p.serverEvents.forEach(fn => fn({
      type: 'redirect',
      newPair: {
        pairId: np,
        aJoinUrl: `${origin}/participant/?pairId=${np}&role=a`,
        bJoinUrl: `${origin}/participant/?pairId=${np}&role=b`
      }
    }));
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
        // Treat as new epoch from client
        side = 'client';
        // if no tasks exist for this epoch, create them
        if (!p.clientTask || !p.serverTask) {
          p.epoch += 1;
          p.turn = p.startingTurn || 'client';
          p.clientTask = newTask(pairId, 'client', `cli:${pairId}#${p.epoch}`);
          p.serverTask = newTask(pairId, 'server', `srv:${pairId}#${p.epoch}`);
          // tell server to subscribe
          p.serverEvents.forEach(fn => fn({ type:'subscribe', pairId, epoch: p.epoch, taskId: p.serverTask!.id, turn: p.turn }));
        }
        task = p.clientTask;
      }
      const t = task!;
      const push = (frame: A2AFrame) => stream.writeSSE({ data: JSON.stringify(frame) });
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
      const push = (frame: A2AFrame) => stream.writeSSE({ data: JSON.stringify(frame) });
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
  const cli = p.clientTask!, srv = p.serverTask!;
  const metadata = readExtension(req.parts);
  const finality = metadata?.finality || 'none';

  // Sender perspective
  const fromTask = from === 'client' ? cli : srv;
  const toTask   = from === 'client' ? srv : cli;

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
  // Send status to sender side (working)
  fromTask.subscribers.forEach(fn => fn({ result: statusUpdate(fromTask, 'working', msgSender) }));

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

  if (finality === 'turn') {
    p.turn = (from === 'client') ? 'server' : 'client';
    setTaskStatus(toTask, 'input-required');
  } else if (finality === 'conversation') {
    setTaskStatus(cli, 'completed');
    setTaskStatus(srv, 'completed');
  } else {
    // non-final messages keep receiver in working; do nothing
  }
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
  if (p.clientTask?.id === id) return p.clientTask;
  if (p.serverTask?.id === id) return p.serverTask;
  return undefined;
}

function setTaskStatus(t: TaskState, state: A2AStatus, message?: A2AMessage) {
  t.status = state;
  const frame = statusUpdate(t, state, message);
  t.subscribers.forEach(fn => fn({ result: frame }));
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
