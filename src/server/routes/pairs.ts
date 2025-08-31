import { Hono } from 'hono'
import type { AppBindings } from '../index'
import { sse } from '../core/sse'

export function pairsRoutes(includeNonApi = false) {
  const r = new Hono<AppBindings>()

  // Note: Explicit pair creation endpoint removed; rooms are created implicitly on first use

  r.get('/pairs/:pairId/metadata', async (c) => {
    const { pairId } = c.req.param()
    const pairs = c.get('pairs')
    const meta = await pairs.getMetadata(pairId)
    if (!meta) return c.json({ error: { message: 'pair not found' } }, 404)
    return c.json({ metadata: meta })
  })

  if (includeNonApi) {
    // Control plane events log
    r.get('/pairs/:pairId/events.log', async (c) => {
      const { pairId } = c.req.param()
      const since = Number(c.req.query('since') || '0') || 0
      const backlogOnly = ['1','true','yes'].includes(String(c.req.query('backlogOnly')||'').toLowerCase())
      if (!backlogOnly) {
        return sse(c, c.get('events').stream(pairId, since))
      }
      const headers = { 'content-type':'text/event-stream', 'cache-control':'no-cache, no-transform', 'connection':'keep-alive', 'x-accel-buffering':'no' }
      const body = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          const write = (obj:any) => controller.enqueue(enc.encode(`data: ${JSON.stringify({ result: obj })}\n\n`))
          try {
            const arr = c.get('events').listSince(pairId, since)
            for (const ev of arr) write(ev)
          } catch {}
          finally { try { controller.close() } catch {} }
        }
      })
      return new Response(body, { status: 200, headers })
    })

    // Responder backchannel: emits subscribe after epoch-begin
    r.get('/pairs/:pairId/server-events', async (c) => {
      const { pairId } = c.req.param()
      const mode = (c.req.query('mode') || 'observer').toLowerCase()
      const takeover = ['1','true','yes'].includes(String(c.req.query('takeover')||'').toLowerCase())
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
          let ping: any = null
          const requestedLeaseId = String(c.req.query('leaseId') || '')
          // Attempt backend lease if requested
          if (mode === 'backend') {
            try {
              const existing = (pairs as any).getLeaseInfo(pairId)
              if (!existing) {
                // No lease exists. Allow fresh acquisition only if no requestedLeaseId and not takeover
                if (requestedLeaseId) {
                  write({ type:'backend-denied' })
                } else {
                  const acq = (pairs as any).acquireBackend(pairId, connId, takeover)
                  if (acq?.granted) { leaseId = acq.leaseId; write({ type:'backend-granted', leaseId: acq.leaseId, leaseGen: acq.leaseGen }) ; granted = true }
                  else { write({ type:'backend-denied' }) }
                }
              } else {
                // Lease exists. Require explicit takeover or matching leaseId rebind
                if (takeover) {
                  const acq = (pairs as any).acquireBackend(pairId, connId, true)
                  if (acq?.granted) { leaseId = acq.leaseId; write({ type:'backend-granted', leaseId: acq.leaseId, leaseGen: acq.leaseGen }) ; granted = true }
                  else { write({ type:'backend-denied' }) }
                } else if (requestedLeaseId && requestedLeaseId === existing.leaseId) {
                  // Rebind same lease to this connection id
                  const ok = (pairs as any).rebindLease(pairId, requestedLeaseId, connId)
                  if (ok) { leaseId = requestedLeaseId; write({ type:'backend-granted', leaseId: requestedLeaseId, leaseGen: existing.leaseGen }) ; granted = true }
                  else { write({ type:'backend-denied' }) }
                } else {
                  write({ type:'backend-denied' })
                }
              }
            } catch {}
          }
          ping = setInterval(() => { try {
            controller.enqueue(enc.encode(`event: ping\ndata: ${Date.now()}\n\n`))
            if (granted) {
              try { (pairs as any).renewBackend(pairId, connId) } catch {}
              // Detect takeover/revocation: if current lease conn differs, revoke this stream
              try {
                const l = (pairs as any).getLeaseInfo(pairId)
                if (!l || l.connId !== connId) {
                  write({ type:'backend-revoked', reason: l ? 'takeover' : 'stale' })
                  clearInterval(ping)
                  try { controller.close() } catch {}
                }
              } catch {}
            }
          } catch {} }, 15000)
          try {
            // On connect, emit subscribe for the current epoch only
            try {
              const ensured = await (pairs as any).ensureEpochTasksForPair(pairId)
              write({ type:'subscribe', pairId, epoch: ensured.epoch, taskId: ensured.responderTaskId, turn: 'initiator' })
            } catch {}
            // Stream future events only (no backlog)
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
          try {
            const pairs = c.get('pairs')
            ;(pairs as any).releaseBackend(pairId, connId)
          } catch {}
        }
      })
      return new Response(body, { status:200, headers })
    })

    // Backend lease release endpoint (sendBeacon-friendly)
    r.post('/pairs/:pairId/backend/release', async (c) => {
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

    r.post('/pairs/:pairId/reset', async (c) => {
      const { pairId } = c.req.param()
      const body = await c.req.json().catch(() => ({}))
      await c.get('pairs').reset(pairId, body?.type === 'soft' ? 'soft' : 'hard')
      return c.json({ ok: true })
    })
  }

  return r
}
