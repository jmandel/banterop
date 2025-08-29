import { Hono } from 'hono'
import type { AppBindings } from '../index'
import { sse } from '../core/sse'

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
              if (ok) { leaseId = leaseIdQuery; write({ type:'backend-granted', leaseId, leaseGen:(pairs as any).getLease(pairId)?.leaseGen||0 }); granted = true }
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
            try { const l = (pairs as any).getLease(pairId); if (!l || l.connId !== connId) { write({ type:'backend-revoked', reason: l ? 'takeover' : 'stale' }); clearInterval(ping); controller.close(); } } catch {}
          }
        } catch {} }, 15000)
        try {
          const ensured = await (pairs as any).ensureEpochTasksForPair(pairId)
          write({ type:'subscribe', pairId, epoch: ensured.epoch, taskId: ensured.responderTaskId, turn: 'initiator' })
          const lastSeqArr = (events as any).listSince(pairId, 0)
          const lastSeq = Array.isArray(lastSeqArr) && lastSeqArr.length ? Number(lastSeqArr[lastSeqArr.length - 1].seq || 0) : 0
          for await (const ev of (events as any).stream(pairId, lastSeq)) {
            const e = ev.result
            if (e?.type === 'epoch-begin' && typeof e.epoch === 'number') {
              const taskId = `resp:${pairId}#${e.epoch}`
              write({ type:'subscribe', pairId, epoch: e.epoch, taskId, turn: 'initiator' })
            }
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
      const l = (pairs as any).getLease(pairId)
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

  return app
}
