import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { loadEnv, type Env } from './core/env'
import { createEventStore } from './core/events'
import { createPersistenceFromDb, type Persistence } from './core/persistence'
import { createPairsService, type PairsService } from './core/pairs'
import { wellKnownRoutes } from './routes/wellKnown'
import { createRoomsRoutes } from './routes/rooms'
import { pairsRoutes } from './routes/pairs'
import { a2aRoutes } from './routes/a2a'
import { mcpRoutes } from './routes/mcp'
import { serve } from 'bun'
import { Database } from 'bun:sqlite'
import { createScenariosStore } from './core/scenarios-store'
import { createScenariosRoutes } from './routes/scenarios'
import { createLLMRoutes } from './routes/llm'
// import { extractNextState, computeStatesForNext } from './core/finality'
// controlHtml removed as default landing; scenarios becomes the main page
import clientHtml from '../frontend/client/index.html'
import roomsHtml from '../frontend/rooms/index.html'
import roomsHistoryHtml from '../frontend/rooms/history.html'
import scenariosHtml from '../frontend/scenarios/index.html'

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

  const sqlite = new Database(env.BANTEROP_DB || ':memory:')
  sqlite.exec('PRAGMA journal_mode = WAL;')
  const db = createPersistenceFromDb(sqlite)
  const eventsMax = Number(((opts?.env as any)?.BANTEROP_EVENTS_MAX ?? process.env.BANTEROP_EVENTS_MAX ?? 1000))
  const roomsMax = Number(((opts?.env as any)?.BANTEROP_ROOMS_MAX ?? process.env.BANTEROP_ROOMS_MAX ?? 100))
  const events = createEventStore({ maxPerPair: eventsMax, maxRooms: roomsMax })
  const pairs = createPairsService({ db, events, baseUrl: env.BASE_URL })

  // Lazy startup: do not seed the in-memory event store from DB.
  // Rooms will appear in the event store upon first activity or subscription.

  app.use('*', async (c, next) => { c.set('db', db); c.set('events', events); c.set('pairs', pairs); await next() })

  app.route('/.well-known', wellKnownRoutes())
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/api', pairsRoutes())
  app.route('/api', a2aRoutes())
  app.route('/api', mcpRoutes())
  // pairsRoutes removed; events + backchannel moved under /api/rooms
  app.route('/api', createRoomsRoutes())
  // Mount LLM + Scenarios routes (previously via install script)
  try {
    const scenarios = createScenariosStore(sqlite)
    app.route('/api', createScenariosRoutes(scenarios))
    app.route('/api', createLLMRoutes())
  } catch (e) {
    try { console.warn('[server] failed to mount LLM/Scenarios routes:', (e as any)?.message || e) } catch {}
  }

  // Note: dynamic HTML for /rooms/:roomId is served via Bun.serve routes below

  const isDev = opts?.development ?? ((Bun.env.NODE_ENV || process.env.NODE_ENV) !== 'production')
  const port = typeof opts?.port === 'number' ? opts!.port : Number(process.env.PORT ?? env.PORT ?? 3000)
  const IDLE_TIMEOUT = 60

  const server = serve({
    idleTimeout: IDLE_TIMEOUT,
    port,
    development: isDev,
    routes: {
      '/': scenariosHtml,
      '/client/': clientHtml,
      '/rooms/': roomsHtml,
      '/scenarios/': scenariosHtml,
      // Serve dynamic room page directly (same bundled HTML)
      '/rooms/:roomId': roomsHtml,
      '/rooms/:roomId/history': roomsHistoryHtml as any,
    },
    async fetch(req, srv) {
      const url = new URL(req.url)
      const staticPages: Record<string, any> = {
        '/': scenariosHtml,
        '/client/': clientHtml,
        '/rooms/': roomsHtml,
        '/scenarios/': scenariosHtml,
      }
      const html = staticPages[url.pathname]
      if (html) return new Response(html as any, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      return app.fetch(req, srv)
    },
  })

  return server
}

if (import.meta.main) {
  const server = createServer()
  const env = loadEnv()
  const isDev = (Bun.env.NODE_ENV || process.env.NODE_ENV) !== 'production'
  const displayUrl = env.BASE_URL || server.url
  try { console.log(`[banterop] ${isDev ? 'Dev' : 'Prod'} server listening on ${displayUrl}`) } catch {}
}
