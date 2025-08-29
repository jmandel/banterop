import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../index'
import { parseRpc, rpcError, e } from '../core/jsonrpc'
import { sse } from '../core/sse'

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
        const stream = pairs.messageStream(pairId, params?.message)
        return sse(c, stream, { rpcId: id })
      }
      case 'message/send': {
        const leaseHeader = c.req.header('x-flipproxy-backend-lease') || c.req.header('X-FlipProxy-Backend-Lease') || null
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
      case 'tasks/resubscribe': {
        const stream = pairs.tasksResubscribe(pairId, params?.id)
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

export function a2aRoutes() {
  const r = new Hono<AppBindings>()
  r.post('/rooms/:pairId/a2a', a2aHandler) // alias route to same handler
  return r
}
