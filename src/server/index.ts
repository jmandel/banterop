import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { loadEnv, type Env } from './core/env'
import { createEventStore } from './core/events'
import { createPersistence, type Persistence } from './core/persistence'
import { createPairsService, type PairsService } from './core/pairs'
import { wellKnownRoutes } from './routes/wellKnown'
import { pairsRoutes } from './routes/pairs'
import { a2aRoutes } from './routes/a2a'
import { mcpRoutes } from './routes/mcp'
import { serve } from 'bun'
import { extractNextState, computeStatesForNext } from './core/finality'
import controlHtml from '../frontend/control/index.html'
import participantHtml from '../frontend/participant/index.html'
import roomsHtml from '../frontend/rooms/index.html'

export type AppBindings = {
  Bindings: Env
  Variables: {
    db: Persistence
    events: ReturnType<typeof createEventStore>
    pairs: PairsService
  }
}

export function createServer(opts?: { port?: number; env?: Partial<Env>; development?: boolean }) {
  const baseEnv = loadEnv()
  const env: Env = { ...baseEnv, ...(opts?.env || {}) }
  const app = new Hono<AppBindings>()

  app.use('*', secureHeaders())
  app.use('*', cors())
  app.use('*', logger())

  const db = createPersistence(env)
  const eventsMax = Number(((opts?.env as any)?.FLIPPROXY_EVENTS_MAX ?? process.env.FLIPPROXY_EVENTS_MAX ?? 5000))
  const events = createEventStore({ maxPerPair: eventsMax })
  const pairs = createPairsService({ db, events, baseUrl: env.BASE_URL })

  // Seed SSE ring from DB for current epochs
  try {
    const all = db.listPairs()
    for (const p of all) {
      const pairId = p.pair_id
      const epoch = p.epoch || 0
      if (epoch <= 0) continue
      events.push(pairId, { type:'epoch-begin', epoch } as any)
      // replay messages (bounded by ring max per pair)
      const rows = db.listMessages(pairId, epoch, { order:'ASC', limit: eventsMax })
      let last: { author:'init'|'resp'; msg:any } | null = null
      for (const r of rows) {
        const msg = (()=>{ try { return JSON.parse(r.json) } catch { return null } })()
        if (!msg) continue
        events.push(pairId, { type:'message', epoch, messageId: String(msg.messageId||''), message: msg } as any)
        last = { author: r.author, msg }
      }
      if (last) {
        const desired = extractNextState(last.msg) ?? 'input-required'
        const states = computeStatesForNext(last.author, desired)
        events.push(pairId, { type:'state', epoch, states, status:{ message:last.msg } } as any)
      } else {
        events.push(pairId, { type:'state', epoch, states:{ initiator:'submitted', responder:'submitted' } } as any)
      }
    }
  } catch {}

  app.use('*', async (c, next) => { c.set('db', db); c.set('events', events); c.set('pairs', pairs); await next() })

  app.route('/.well-known', wellKnownRoutes())
  app.route('/api', pairsRoutes())
  app.route('/api', a2aRoutes())
  app.route('/api', mcpRoutes())
  app.route('/api', pairsRoutes(true))

  // Rooms: serve agent card (dynamic JSON)
  app.get('/rooms/:roomId/agent-card.json', (c) => {
    const { roomId } = c.req.param()
    const origin = new URL(c.req.url).origin
    const json = {
      name: 'flipproxy-room',
      version: '1.0',
      endpoints: {
        a2a: `/api/bridge/${roomId}/a2a`,
        mcp: `/api/bridge/${roomId}/mcp`,
        tasks: `/api/pairs/${roomId}/server-events`
      }
    }
    return c.json(json)
  })
  // Note: dynamic HTML for /rooms/:roomId is served via Bun.serve routes below

  const isDev = opts?.development ?? ((Bun.env.NODE_ENV || process.env.NODE_ENV) !== 'production')
  const port = typeof opts?.port === 'number' ? opts!.port : Number(process.env.PORT ?? env.PORT ?? 3000)
  const IDLE_TIMEOUT = 60

  const server = serve({
    idleTimeout: IDLE_TIMEOUT,
    port,
    development: isDev ? { hmr: true, console: true } : undefined,
    routes: {
      '/': controlHtml,
      '/control/': controlHtml,
      '/participant/': participantHtml,
      '/rooms/': roomsHtml,
      // Serve dynamic room page directly (same bundled HTML)
      '/rooms/:roomId': roomsHtml,
    },
    async fetch(req, srv) {
      const url = new URL(req.url)
      const staticPages: Record<string, string> = {
        '/': controlHtml,
        '/control/': controlHtml,
        '/participant/': participantHtml,
        '/rooms/': roomsHtml,
      }
      const html = staticPages[url.pathname]
      if (html) return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      return app.fetch(req, srv)
    },
  })

  return server
}

if (import.meta.main) {
  const server = createServer()
  try { console.log(`[flipproxy] ${((Bun.env.NODE_ENV || process.env.NODE_ENV) !== 'production') ? 'Dev' : 'Prod'} server listening on ${server.url}`) } catch {}
}
