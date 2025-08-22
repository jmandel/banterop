import { Hono } from 'hono'
import { serve } from 'hono/bun'
import { streamSSE } from 'hono/streaming'
import { A2AMessage, A2AFrame, A2AStatus, A2ATask } from './shared/a2a-types'
import type { ServerEvent } from './shared/backchannel-types'

type Side = 'a'|'b'

type Subscriber = {
  send: (obj: any) => void
  close: () => void
}

type TaskState = {
  id: string
  side: Side
  contextId: string
  history: A2AMessage[]
  status: A2AStatus
}

type PairState = {
  id: string
  epoch: number
  turn: Side
  aTaskId?: string
  bTaskId?: string
  taskSubs: { a: Set<Subscriber>, b: Set<Subscriber> }
  serverEvents: Set<Subscriber> // only responder listens
  tasks: Map<string, TaskState>
}

const pairs = new Map<string, PairState>()

function newPair(id?: string): PairState {
  const pid = id || crypto.randomUUID().slice(0, 8)
  const p: PairState = {
    id: pid,
    epoch: 0,
    turn: 'a',
    taskSubs: { a: new Set(), b: new Set() },
    serverEvents: new Set(),
    tasks: new Map()
  }
  pairs.set(pid, p)
  return p
}
function getPair(id: string) {
  let p = pairs.get(id)
  if (!p) p = newPair(id)
  return p
}
function makeTaskId(pairId: string, side: Side, epoch: number) {
  return `${pairId}:${side}:${epoch}`
}
function sseSubscriber(c: any): Subscriber {
  return {
    send: (obj: any) => c.writeSSE({ data: JSON.stringify({ result: obj }) }),
    close: () => { try { c.close() } catch {} }
  }
}
function pushServerEvent(p: PairState, ev: ServerEvent) {
  for (const sub of p.serverEvents) {
    try { sub.send(ev) } catch {}
  }
}
function broadcastTo(p: PairState, side: Side, obj: any) {
  for (const sub of p.taskSubs[side]) {
    try { sub.send(obj) } catch {}
  }
}
function taskSnapshot(t: TaskState): A2ATask {
  return { id: t.id, contextId: t.contextId, status: { state: t.status }, history: t.history, kind: 'task' }
}
function readFinality(parts?: any[]): 'turn'|'conversation'|'none' {
  if (!Array.isArray(parts)) return 'none'
  for (const p of parts) {
    const meta = (p && typeof p === 'object' && 'metadata' in p) ? (p as any).metadata : undefined
    const ext = meta?.['urn:cc:a2a:v1']
    const fin = ext?.finality
    if (fin === 'turn' || fin === 'conversation') return fin
  }
  return 'none'
}

const app = new Hono()

// Static
app.get('/', (c) => c.redirect('/index.html'))
app.get('/index.html', async (c) => {
  const file = await Bun.file('public/index.html').text()
  return c.html(file)
})
app.get('/assets/:file', async (c) => {
  const f = c.req.param('file')
  const file = Bun.file('public/assets/' + f)
  return new Response(file, { headers: { 'content-type': 'text/javascript' } })
})

// Create pair + admin links (very simple demo)
app.post('/api/pairs', async (c) => {
  const p = newPair()
  const base = c.req.url.replace(/\/api\/pairs.*/,'')
  const origin = new URL(base).origin
  const aJoinUrl = `${origin}/?pairId=${p.id}&role=a`
  const bJoinUrl = `${origin}/?pairId=${p.id}&role=b`
  return c.json({ pairId: p.id, aJoinUrl, bJoinUrl })
})

// Resets
app.post('/api/pairs/:pairId/reset', async (c) => {
  const pairId = c.req.param('pairId')
  const { type } = await c.req.json().catch(() => ({ type: 'soft' }))
  const p = getPair(pairId)
  if (type === 'soft') {
    // cancel old tasks
    if (p.aTaskId) broadcastTo(p, 'a', { kind:'status-update', taskId: p.aTaskId, contextId: pairId, status:{ state: 'canceled' } })
    if (p.bTaskId) broadcastTo(p, 'b', { kind:'status-update', taskId: p.bTaskId, contextId: pairId, status:{ state: 'canceled' } })
    // bump epoch and notify responder to subscribe new task
    p.epoch += 1
    p.turn = 'a'
    const bTaskId = makeTaskId(pairId, 'b', p.epoch)
    pushServerEvent(p, { type: 'unsubscribe', pairId, epoch: p.epoch-1, reason: 'reset-soft' })
    pushServerEvent(p, { type: 'subscribe', pairId, epoch: p.epoch, taskId: bTaskId, turn: 'a' })
    // reset task ids; sender (client) will start new by calling message/stream
    p.aTaskId = makeTaskId(pairId, 'a', p.epoch)
    p.bTaskId = bTaskId
    // seed tasks (empty history)
    const aTask: TaskState = { id: p.aTaskId, side: 'a', contextId: pairId, history: [], status: 'submitted' }
    const bTask: TaskState = { id: p.bTaskId, side: 'b', contextId: pairId, history: [], status: 'submitted' }
    p.tasks.set(aTask.id, aTask); p.tasks.set(bTask.id, bTask)
    return c.json({ ok: true, epoch: p.epoch })
  } else {
    // hard reset: new pair
    const p2 = newPair()
    const base = c.req.url.replace(/\/api\/pairs.*/,'')
    const origin = new URL(base).origin
    const aJoinUrl = `${origin}/?pairId=${p2.id}&role=a`
    const bJoinUrl = `${origin}/?pairId=${p2.id}&role=b`
    pushServerEvent(p, { type: 'redirect', newPair: { pairId: p2.id, aJoinUrl, bJoinUrl } })
    // optionally drop old
    pairs.delete(p.id)
    return c.json({ ok: true, newPair: { pairId: p2.id, aJoinUrl, bJoinUrl } })
  }
})

// Responder-only backchannel
app.get('/api/bridge/:pairId/server-events', async (c) => {
  const pairId = c.req.param('pairId')
  const p = getPair(pairId)
  return streamSSE(c, async (stream) => {
    const sub = sseSubscriber(stream)
    p.serverEvents.add(sub)
    // on connect, if a current epoch exists, tell to subscribe
    if (p.epoch > 0 && p.bTaskId) {
      sub.send({ type: 'subscribe', pairId, epoch: p.epoch, taskId: p.bTaskId, turn: p.turn })
    }
    stream.onAbort(() => { p.serverEvents.delete(sub) })
  })
})

// JSON-RPC A2A endpoint (both client and responder use it)
app.post('/api/bridge/:pairId/:role', async (c) => {
  const pairId = c.req.param('pairId')
  const role = (c.req.param('role') as Side)
  const p = getPair(pairId)
  const body = await c.req.json()
  const method = body?.method
  const params = body?.params || {}

  if (method === 'tasks/get') {
    const id = params?.id || params?.taskId
    const t = id ? p.tasks.get(String(id)) : undefined
    if (!t) return c.json({ result: null, error: { message: 'not found' } })
    return c.json({ result: taskSnapshot(t) })
  }

  if (method === 'tasks/cancel') {
    const id = params?.id
    const t = id ? p.tasks.get(String(id)) : undefined
    if (t) {
      t.status = 'canceled'
      broadcastTo(p, t.side, { kind:'status-update', taskId: t.id, contextId: pairId, status:{ state: 'canceled' } })
    }
    return c.json({ result: { ok: true } })
  }

  if (method === 'message/send') {
    // Non-streaming fallback: accept and reflect once
    const msg = params?.message
    await handleIncomingMessage(p, role, msg)
    return c.json({ result: { ok: true } })
  }

  if (method === 'message/stream' or method === 'tasks/resubscribe') {
    // Streaming channel: attach a subscriber for this side+task
    return streamSSE(c, async (stream) => {
      const sub = sseSubscriber(stream)
      const isResub = method === 'tasks/resubscribe'
      let taskId: string | undefined = params?.id || params?.message?.taskId

      // If message/stream with NO taskId → start new epoch (client-initiated)
      if (!isResub && (!taskId || String(taskId).trim() === '')) {
        p.epoch += 1
        p.turn = 'a'
        p.aTaskId = makeTaskId(pairId, 'a', p.epoch)
        p.bTaskId = makeTaskId(pairId, 'b', p.epoch)
        const aTask: TaskState = { id: p.aTaskId!, side: 'a', contextId: pairId, history: [], status: 'submitted' }
        const bTask: TaskState = { id: p.bTaskId!, side: 'b', contextId: pairId, history: [], status: 'submitted' }
        p.tasks.set(aTask.id, aTask); p.tasks.set(bTask.id, bTask)
        // Notify responder to hop to the new task
        pushServerEvent(p, { type: 'unsubscribe', pairId, epoch: p.epoch-1, reason: 'client-new-epoch' })
        pushServerEvent(p, { type: 'subscribe', pairId, epoch: p.epoch, taskId: p.bTaskId!, turn: 'a' })
        taskId = role === 'a' ? p.aTaskId : p.bTaskId
        // Seed 'task' snapshot to sender
        const t = p.tasks.get(taskId!)!
        sub.send({ ...taskSnapshot(t) })
        sub.send({ kind: 'status-update', taskId: t.id, contextId: pairId, status: { state: 'working' } })
      }

      // If resubscribe, just send current snapshot
      if (isResub) {
        const t = taskId ? p.tasks.get(taskId) : undefined
        if (t) {
          sub.send({ ...taskSnapshot(t) })
        }
      }

      // attach subscriber
      p.taskSubs[role].add(sub)
      stream.onAbort(() => { p.taskSubs[role].delete(sub) })

      // If message/stream contained a new message, process it
      if (!isResub && params?.message) {
        await handleIncomingMessage(p, role, params.message, sub)
      }
    })
  }

  return c.json({ error: { message: 'unknown method' } }, 400)
})

// Core reflection logic
async function handleIncomingMessage(p: PairState, from: Side, msg: any, maybeSender?: Subscriber) {
  if (!msg) return
  const epoch = p.epoch || 1
  const senderTaskId = (from === 'a') ? p.aTaskId : p.bTaskId
  const recvSide: Side = (from === 'a') ? 'b' : 'a'
  const recvTaskId = (recvSide === 'a') ? p.aTaskId : p.bTaskId
  if (!senderTaskId || !recvTaskId) return

  const senderTask = p.tasks.get(senderTaskId)!
  const recvTask = p.tasks.get(recvTaskId)!

  const fin = readFinality(msg.parts)

  // append to sender history (as 'user')
  const userMsg: A2AMessage = {
    role: 'user',
    parts: msg.parts || [],
    messageId: msg.messageId || crypto.randomUUID(),
    taskId: senderTask.id,
    contextId: senderTask.contextId,
    kind: 'message'
  }
  senderTask.history.push(userMsg)
  senderTask.status = 'working'

  // echo status to sender stream if available
  const su = { kind: 'status-update', taskId: senderTask.id, contextId: senderTask.contextId, status: { state: 'working', message: userMsg } }
  if (maybeSender) maybeSender.send(su)
  broadcastTo(p, from, su)

  // reflect to receiver (as 'agent')
  const agentMsg: A2AMessage = {
    role: 'agent',
    parts: msg.parts || [],
    messageId: msg.messageId || crypto.randomUUID(),
    taskId: recvTask.id,
    contextId: recvTask.contextId,
    kind: 'message'
  }
  recvTask.history.push(agentMsg)
  // push to receiver subscribers
  broadcastTo(p, recvSide, agentMsg)

  // turn switching based on finality
  if (fin === 'turn') {
    p.turn = recvSide
    recvTask.status = 'input-required'
    broadcastTo(p, recvSide, { kind:'status-update', taskId: recvTask.id, contextId: recvTask.contextId, status:{ state: 'input-required' } })
  } else if (fin === 'conversation') {
    senderTask.status = 'completed'
    recvTask.status = 'completed'
    broadcastTo(p, 'a', { kind:'status-update', taskId: senderTask.id, contextId: senderTask.contextId, status:{ state: 'completed' } })
    broadcastTo(p, 'b', { kind:'status-update', taskId: recvTask.id, contextId: recvTask.contextId, status:{ state: 'completed' } })
  }
}

const port = Number(process.env.PORT || 3000)
console.log(`[flipproxy] listening on http://localhost:${port}`)
serve({ fetch: app.fetch, port })
