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
import { fetchJsonRoutes } from './routes/fetchJson'
import { mcpRoutes } from './routes/mcp'
import { serve } from 'bun'
import controlHtml from '../frontend/control/index.html'
import participantHtml from '../frontend/participant/index.html'

export type AppBindings = {
  Bindings: Env
  Variables: {
    db: Persistence
    events: ReturnType<typeof createEventStore>
    pairs: PairsService
  }
}

const env = loadEnv()
const app = new Hono<AppBindings>()

app.use('*', secureHeaders())
app.use('*', cors())
app.use('*', logger())

const db = createPersistence(env)
const events = createEventStore()
const pairs = createPairsService({ db, events, baseUrl: env.BASE_URL })

app.use('*', async (c, next) => { c.set('db', db); c.set('events', events); c.set('pairs', pairs); await next() })

app.route('/.well-known', wellKnownRoutes())
app.route('/api', pairsRoutes())
app.route('/api', a2aRoutes())
app.route('/api', mcpRoutes())
app.route('/api', fetchJsonRoutes())
app.route('/api', pairsRoutes(true))

// Bun.serve handles HTML routes and delegates everything else to Hono
const isDev = (Bun.env.NODE_ENV || process.env.NODE_ENV) !== 'production'
const port = Number(process.env.PORT ?? env.PORT ?? 3000)
const IDLE_TIMEOUT = 60

const server = serve({
  idleTimeout: IDLE_TIMEOUT,
  port,
  development: isDev ? { hmr: true, console: true } : undefined,
  routes: {
    '/': controlHtml,
    '/control/': controlHtml,
    '/participant/': participantHtml,
  },
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (!['/','/control/','/participant/'].includes(url.pathname)) {
      return app.fetch(req, srv)
    }
    return new Response('Not Found', { status: 404 })
  },
})

try { console.log(`[flipproxy] ${isDev ? 'Dev' : 'Prod'} server listening on ${server.url}`) } catch {}
