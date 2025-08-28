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
import clientHtml from '../frontend/client/index.html'
import roomsHtml from '../frontend/rooms/index.html'
import { A2A_EXT_URL } from '../shared/core'

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

  // Rooms: serve AgentCard (dynamic JSON) with metadata deep-merge overrides
  app.get('/rooms/:roomId/agent-card.json', async (c) => {
    const { roomId } = c.req.param()
    const origin = new URL(c.req.url).origin

    function deepMerge<T extends Record<string, any>>(a: T, b: Partial<T>): T {
      const out: any = Array.isArray(a) ? [...(a as any)] : { ...(a as any) }
      for (const [k,v] of Object.entries(b || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
          out[k] = deepMerge(out[k], v as any)
        } else {
          out[k] = v
        }
      }
      return out
    }

    // Build a richer default AgentCard following the spec
    const a2aAlias = `${origin}/api/rooms/${roomId}/a2a`
    const a2a = `${origin}/api/bridge/${roomId}/a2a`
    const mcp = `${origin}/api/bridge/${roomId}/mcp`
    const tasks = `${origin}/api/pairs/${roomId}/server-events`
    const defaultCard = {
      protocolVersion: '0.3.0',
      name: `Conversational Interop Room: ${roomId}`,
      description: 'Conversational interoperability agent that brokers A2A messages between an initiator and a browser-hosted responder with planner orchestration for healthcare tasks.',
      url: a2aAlias,
      preferredTransport: 'JSONRPC',
      additionalInterfaces: [
        { url: a2aAlias, transport: 'JSONRPC' }
      ],
      iconUrl: undefined,
      provider: { organization: 'Josh Mandel', url: 'https://joshuamandel.com' },
      version: '1.0.0',
      documentationUrl: undefined,
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true, extensions: [ { uri: A2A_EXT_URL, description: 'FlipProxy extension fields (e.g., nextState) used in A2A messages', required: false, params: { a2a: a2aAlias, mcp, tasks } } ] },
      securitySchemes: undefined,
      security: undefined,
      defaultInputModes: ['text/plain', 'application/json', 'application/octet-stream'],
      defaultOutputModes: ['text/plain', 'application/json', 'application/octet-stream'],
      skills: [
        {
          id: 'conversational-interoperability',
          name: 'Conversational Interoperability',
          description: 'Engage in multi-turn conversations to accomplish healthcare tasks with interoperable messaging and planning.',
          tags: ['healthcare','interop','conversation'],
          examples: ['Summarize the patient history and ask for missing details.'],
          inputModes: ['text/plain','application/json'],
          outputModes: ['text/plain','application/json']
        }
      ],
      supportsAuthenticatedExtendedCard: false,
      signatures: undefined,
    } as any

    // Allow room metadata to override/extend via metadata.agentCard
    let merged = defaultCard
    try {
      const meta = await c.get('pairs').getMetadata(roomId)
      // Start from AGENT_CARD_TEMPLATE if provided (supports {{roomId}}, {{BASE_URL}}, {{origin}})
      const base = (() => {
        const tmpl = (c.env as any)?.AGENT_CARD_TEMPLATE || (process.env.AGENT_CARD_TEMPLATE || '')
        if (!tmpl || typeof tmpl !== 'string') return null
        try {
          const subst = tmpl
            .replaceAll('{{roomId}}', roomId)
            .replaceAll('{{BASE_URL}}', String((c.env as any)?.BASE_URL || process.env.BASE_URL || origin))
            .replaceAll('{{origin}}', origin)
          return JSON.parse(subst)
        } catch { return null }
      })()
      const agentCard = meta && meta.agentCard ? meta.agentCard : null
      merged = base ? deepMerge(base, defaultCard) : defaultCard
      if (agentCard && typeof agentCard === 'object') merged = deepMerge(merged, agentCard)
    } catch {}

    return c.json(merged)
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
      '/client/': clientHtml,
      '/rooms/': roomsHtml,
      // Serve dynamic room page directly (same bundled HTML)
      '/rooms/:roomId': roomsHtml,
    },
    async fetch(req, srv) {
      const url = new URL(req.url)
      const staticPages: Record<string, string> = {
        '/': controlHtml,
        '/control/': controlHtml,
        '/client/': clientHtml,
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
