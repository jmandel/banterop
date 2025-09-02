import { Hono } from 'hono'
import type { AppBindings } from '../index'
import { sse } from '../core/sse'
import { initTaskId, respTaskId } from '../core/ids'
import { extractNextState, computeStatesForNext } from '../core/finality'

export function createRoomsRoutes() {
  const app = new Hono<AppBindings>()

  // Room-wide event log (SSE); replaces /api/pairs/:pairId/events.log
  app.get('/rooms/:pairId/events.log', async (c) => {
    const { pairId } = c.req.param()
    const since = Number(c.req.query('since') || '0') || 0
    const backlogOnly = ['1','true','yes'].includes(String(c.req.query('backlogOnly')||'').toLowerCase())
    const events = c.get('events')
    if (!backlogOnly) return sse(c, events.stream(pairId, since))
    const headers = { 'content-type':'text/event-stream', 'cache-control':'no-cache, no-transform', 'connection':'keep-alive', 'x-accel-buffering':'no' }
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        const write = (obj:any) => controller.enqueue(enc.encode(`data: ${JSON.stringify({ result: obj })}\n\n`))
        try { for (const ev of (events as any).listSince(pairId, since)) write(ev) } catch {}
        finally { try { controller.close() } catch {} }
      }
    })
    return new Response(body, { status: 200, headers })
  })

  // Responder backchannel (SSE) for Rooms; replaces /api/pairs/:pairId/server-events
  app.get('/rooms/:pairId/server-events', async (c) => {
    const { pairId } = c.req.param()
    const mode = (c.req.query('mode') || 'observer').toLowerCase()
    const takeover = ['1','true','yes'].includes(String(c.req.query('takeover')||'').toLowerCase())
    const leaseIdQuery = String(c.req.query('leaseId') || '')
    const headers = { 'content-type':'text/event-stream', 'cache-control':'no-cache, no-transform', 'connection':'keep-alive', 'x-accel-buffering':'no' }
    const connId = crypto.randomUUID()
    const body = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        const write = (obj:any) => controller.enqueue(enc.encode(`data: ${JSON.stringify({ result: obj })}\n\n`))
        const events = c.get('events')
        const pairs = c.get('pairs')
        let granted = false
        let leaseId: string | undefined
        // Attempt backend lease if requested
        if (mode === 'backend') {
          try {
            if (leaseIdQuery) {
              const ok = (pairs as any).rebindLease(pairId, leaseIdQuery, connId)
              if (ok) { leaseId = leaseIdQuery; write({ type:'backend-granted', leaseId, leaseGen:(pairs as any).getLeaseInfo(pairId)?.leaseGen||0 }); granted = true }
              else { write({ type:'backend-denied' }) }
            } else {
              const acq = (pairs as any).acquireBackend(pairId, connId, takeover)
              if (acq?.granted) { leaseId = acq.leaseId; write({ type:'backend-granted', leaseId: acq.leaseId, leaseGen: acq.leaseGen }) ; granted = true }
              else { write({ type:'backend-denied' }) }
            }
          } catch {}
        }
        const ping = setInterval(() => { try {
          controller.enqueue(enc.encode(`event: ping\ndata: ${Date.now()}\n\n`))
          if (granted) {
            try { (pairs as any).renewBackend(pairId, connId) } catch {}
            try { const l = (pairs as any).getLeaseInfo(pairId); if (!l || l.connId !== connId) { write({ type:'backend-revoked', reason: l ? 'takeover' : 'stale' }); clearInterval(ping); controller.close(); } } catch {}
          }
        } catch {} }, 15000)
        try {
          const ensured = await (pairs as any).ensureEpochTasksForPair(pairId)
          write({ type:'subscribe', pairId, epoch: ensured.epoch, taskId: ensured.responderTaskId, turn: 'initiator' })
          const lastSeqArr = (events as any).listSince(pairId, 0)
          const lastSeq = Array.isArray(lastSeqArr) && lastSeqArr.length ? Number(lastSeqArr[lastSeqArr.length - 1].seq || 0) : 0
          for await (const ev of (events as any).stream(pairId, lastSeq)) {
            const e = ev.result
            // Maintain subscribe notifications on epoch boundaries for room app
            if (e?.type === 'epoch-begin' && typeof e.epoch === 'number') {
              const taskId = `resp:${pairId}#${e.epoch}`
              write({ type:'subscribe', pairId, epoch: e.epoch, taskId, turn: 'initiator' })
            }
            // Broadcast all events, including client-wire-event, state, message, etc.
            write(e)
          }
        } catch {}
        finally {
          clearInterval(ping)
          if (granted) { try { (pairs as any).releaseBackend(pairId, connId) } catch {} }
          try { controller.close() } catch {}
        }
      },
      cancel() {
        try { /* ensure lease release on client disconnect */ } catch {}
        try { const pairs = c.get('pairs'); (pairs as any).releaseBackend(pairId, connId) } catch {}
      }
    })
    return new Response(body, { status:200, headers })
  })

  app.post('/rooms/:pairId/backend/release', async (c) => {
    const { pairId } = c.req.param()
    const form = await c.req.formData().catch(()=>null)
    const leaseId = form ? String(form.get('leaseId') || '') : ''
    const pairs = c.get('pairs')
    try {
      const l = (pairs as any).getLeaseInfo(pairId)
      if (l && l.leaseId && leaseId && l.leaseId === leaseId) {
        ;(pairs as any).releaseBackend(pairId, l.connId)
      }
    } catch {}
    return c.json({ ok: true })
  })

  app.post('/rooms/:pairId/reset', async (c) => {
    const { pairId } = c.req.param()
    const body = await c.req.json().catch(() => ({}))
    await c.get('pairs').reset(pairId, body?.type === 'soft' ? 'soft' : 'hard')
    return c.json({ ok: true })
  })

  // ---- Task history (epochs) listing for a room ----
  app.get('/rooms/:pairId/epochs', async (c) => {
    const { pairId } = c.req.param()
    const order = (c.req.query('order') || 'desc').toLowerCase()
    const limit = Math.max(0, Math.floor(Number(c.req.query('limit') || '0') || 0))

    const db = c.get('db')
    const p = db.getPair(pairId)
    if (!p) return c.json({ pairId, currentEpoch: 0, epochs: [] })
    const currentEpoch = p.epoch || 0
    const epochs: Array<{ epoch:number; initiatorTaskId:string; responderTaskId:string; state:string; messageCount:number }> = []
    const start = 1
    const end = currentEpoch
    const seq: number[] = []
    for (let i = start; i <= end; i++) seq.push(i)
    const ordered = order === 'asc' ? seq : seq.reverse()
    const capped = limit > 0 ? ordered.slice(0, limit) : ordered
    for (const epoch of capped) {
      // Count messages for this epoch (bounded)
      const rows = db.listMessages(pairId, epoch, { order:'ASC', limit: 10000 })
      const last = db.lastMessage(pairId, epoch)
      let state: string = 'submitted'
      if (last) {
        let obj: any = {}
        try { obj = JSON.parse(last.json) } catch {}
        const desired = extractNextState(obj) ?? 'working'
        const both = computeStatesForNext(last.author, desired)
        state = (both as any).init || 'submitted'
      }
      epochs.push({
        epoch,
        initiatorTaskId: initTaskId(pairId, epoch),
        responderTaskId: respTaskId(pairId, epoch),
        state,
        messageCount: rows.length,
      })
    }
    return c.json({ pairId, currentEpoch, epochs })
  })

  // Per-epoch snapshot (A2A Task) for transcript viewing
  app.get('/rooms/:pairId/epochs/:epoch', async (c) => {
    const { pairId, epoch: epochStr } = c.req.param()
    const viewer = (c.req.query('viewer') || 'init').toLowerCase() === 'resp' ? 'resp' : 'init'
    const epoch = Math.max(1, Math.floor(Number(epochStr) || 1))
    const id = viewer === 'resp' ? respTaskId(pairId, epoch) : initTaskId(pairId, epoch)
    try {
      const snap = await c.get('pairs').tasksGet(pairId, id)
      return c.json(snap)
    } catch (e) {
      return c.json({ error: { message: String((e as any)?.message || 'failed') } }, 400)
    }
  })

  return app
}
