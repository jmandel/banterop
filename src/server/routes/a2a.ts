import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../index'
import { parseRpc, rpcError, e } from '../core/jsonrpc'
import { sse } from '../core/sse'
import { validateAgentCard } from '../core/a2a-validator'
import { A2A_EXT_URL } from '../../shared/core'

async function a2aHandler(c: Context<AppBindings>) {
  const { pairId } = c.req.param()
  const pairs = c.get('pairs')

  let rpc
  try { rpc = await parseRpc(c) }
  catch (err) { return c.json(rpcError(e.PARSE_ERROR, (err as Error).message), 200) }
  if (!rpc) return c.json(rpcError(e.INVALID_REQUEST, 'Invalid JSON-RPC request'), 200)

  const { id, method, params } = rpc

  try {
    switch (method) {
      case 'message/stream': {
        const leaseHeader = c.req.header('x-banterop-backend-lease') || c.req.header('X-Banterop-Backend-Lease') || null
        const stream = pairs.messageStream(pairId, params?.message, leaseHeader)
        return sse(c, stream, { rpcId: id })
      }
      case 'message/send': {
        const leaseHeader = c.req.header('x-banterop-backend-lease') || c.req.header('X-Banterop-Backend-Lease') || null
        const snap = await pairs.messageSend(pairId, params?.message, params?.configuration, leaseHeader)
        return c.json({ jsonrpc: '2.0', id, result: snap })
      }
      case 'tasks/get': {
        const snap = await pairs.tasksGet(pairId, params?.id)
        return c.json({ jsonrpc: '2.0', id, result: snap })
      }
      case 'tasks/cancel': {
        const snap = await pairs.tasksCancel(pairId, params?.id)
        return c.json({ jsonrpc: '2.0', id, result: snap })
      }
      case 'tasks/resubscribe':
      case 'tasks/subscribe': { // alias for spec compatibility
        // Forward lease header if present for audience-scoped diagnostics
        const leaseHeader = c.req.header('x-banterop-backend-lease') || c.req.header('X-Banterop-Backend-Lease') || null
        const stream = pairs.tasksResubscribe(pairId, params?.id, leaseHeader)
        return sse(c, stream, { rpcId: id })
      }
      default:
        return c.json(rpcError(e.METHOD_NOT_FOUND, 'Method not found', id), 200)
    }
  } catch (err) {
    const code = (err as any)?.code === 'INVALID_PARAMS' ? e.INVALID_PARAMS : e.SERVER_ERROR
    return c.json(rpcError(code, String((err as Error).message), id), 200)
  }
}

// Agent card handler (moved from rooms.ts)
async function agentCardHandler(c: Context<AppBindings>) {
  const { roomId } = c.req.param()
  const origin = new URL(c.req.url).origin
  // Use BASE_URL from environment if available, otherwise fall back to request origin
  const baseUrl = (c.env as any)?.BASE_URL || process.env.BASE_URL || origin

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

  const a2aAlias = `${baseUrl}/api/rooms/${roomId}/a2a`
  const a2a = `${baseUrl}/api/rooms/${roomId}/a2a`
  const mcp = `${baseUrl}/api/rooms/${roomId}/mcp`
  const tasks = `${baseUrl}/api/rooms/${roomId}/server-events`
  const defaultCard: any = {
    protocolVersion: '0.3.0',
    name: `Conversational Interop Room: ${roomId}`,
    description: 'Conversational interoperability agent that brokers A2A messages between an initiator and a browser-hosted responder with planner orchestration for healthcare tasks.',
    url: a2aAlias,
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [ { url: a2aAlias, transport: 'JSONRPC' } ],
    provider: { organization: 'Josh Mandel', url: 'https://joshuamandel.com' },
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true, extensions: [ { uri: A2A_EXT_URL, description: 'Banterop extension fields (e.g., nextState) used in A2A messages', required: false, params: { a2a: a2aAlias, mcp, tasks } } ] },
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

  // Validate the agent card (log-only)
  try { validateAgentCard(merged, { roomId }) } catch {}
  
  return c.json(merged)
}

export function a2aRoutes() {
  const r = new Hono<AppBindings>()
  r.post('/rooms/:pairId/a2a', a2aHandler) // alias route to same handler
  
  // A2A-compliant well-known path for agent cards
  r.get('/rooms/:roomId/.well-known/agent-card.json', agentCardHandler)
  
  return r
}
