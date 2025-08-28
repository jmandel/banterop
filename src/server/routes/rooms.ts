import { Hono } from 'hono'
import type { AppBindings } from '../index'
import { A2A_EXT_URL } from '../../shared/core'

export function createRoomsRoutes() {
  const app = new Hono<AppBindings>()

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

    const a2aAlias = `${origin}/api/rooms/${roomId}/a2a`
    const a2a = `${origin}/api/bridge/${roomId}/a2a`
    const mcp = `${origin}/api/bridge/${roomId}/mcp`
    const tasks = `${origin}/api/pairs/${roomId}/server-events`
    const defaultCard: any = {
      protocolVersion: '0.3.0',
      name: `Conversational Interop Room: ${roomId}`,
      description: 'Conversational interoperability agent that brokers A2A messages between an initiator and a browser-hosted responder with planner orchestration for healthcare tasks.',
      url: a2aAlias,
      preferredTransport: 'JSONRPC',
      additionalInterfaces: [ { url: a2aAlias, transport: 'JSONRPC' } ],
      provider: { organization: 'Josh Mandel', url: 'https://joshuamandel.com' },
      version: '1.0.0',
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true, extensions: [ { uri: A2A_EXT_URL, description: 'FlipProxy extension fields (e.g., nextState) used in A2A messages', required: false, params: { a2a: a2aAlias, mcp, tasks } } ] },
      defaultInputModes: ['text/plain','application/json','application/octet-stream'],
      defaultOutputModes: ['text/plain','application/json','application/octet-stream'],
      skills: [ { id:'conversational-interoperability', name:'Conversational Interoperability', description:'Engage in multi-turn conversations to accomplish healthcare tasks with interoperable messaging and planning.', tags:['healthcare','interop','conversation'], inputModes:['text/plain','application/json'], outputModes:['text/plain','application/json'] } ],
      supportsAuthenticatedExtendedCard: false,
    }

    let merged = defaultCard
    try {
      const meta = await c.get('pairs').getMetadata(roomId)
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
      const agentCard = meta && (meta as any).agentCard ? (meta as any).agentCard : null
      merged = base ? deepMerge(base, defaultCard) : defaultCard
      if (agentCard && typeof agentCard === 'object') merged = deepMerge(merged, agentCard)
    } catch {}

    return c.json(merged)
  })

  return app
}
