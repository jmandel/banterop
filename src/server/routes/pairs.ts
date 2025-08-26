import { Hono } from 'hono'
import type { AppBindings } from '../index'
import { sse } from '../core/sse'

export function pairsRoutes(includeNonApi = false) {
  const r = new Hono<AppBindings>()

  r.post('/pairs', async (c) => {
    const pairs = c.get('pairs')
    const origin = new URL(c.req.url).origin
    const created = await pairs.createPair()
    const base = origin
    const a2a = `${base}/api/bridge/${created.pairId}/a2a`
    const mcp = `${base}/api/bridge/${created.pairId}/mcp`
    const a2aAgentCard = `${base}/.well-known/agent-card.json`
    const tasks = `${base}/api/pairs/${created.pairId}/server-events`
    return c.json({
      pairId: created.pairId,
      endpoints: { a2a, mcp, a2aAgentCard },
      links: {
        initiator: { joinA2a: `${base}/participant/?role=initiator&a2a=${encodeURIComponent(a2a)}`, joinMcp: `${base}/participant/?role=initiator&transport=mcp&mcp=${encodeURIComponent(mcp)}` },
        responder: { joinA2a: `${base}/participant/?role=responder&a2a=${encodeURIComponent(a2a)}&tasks=${encodeURIComponent(tasks)}` },
      }
    })
  })

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
      return sse(c, c.get('events').stream(pairId, since))
    })

    // Responder backchannel: emits subscribe after epoch-begin
    r.get('/pairs/:pairId/server-events', async (c) => {
      const { pairId } = c.req.param()
      const headers = { 'content-type':'text/event-stream', 'cache-control':'no-cache, no-transform', 'connection':'keep-alive', 'x-accel-buffering':'no' }
      const body = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder()
          const write = (obj:any) => controller.enqueue(enc.encode(`data: ${JSON.stringify({ result: obj })}\n\n`))
          const events = c.get('events')
          const pairs = c.get('pairs')
          const ping = setInterval(() => { try { controller.enqueue(enc.encode(`event: ping\ndata: ${Date.now()}\n\n`)) } catch {} }, 15000)
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
          finally { clearInterval(ping); try { controller.close() } catch {} }
        }
      })
      return new Response(body, { status:200, headers })
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
