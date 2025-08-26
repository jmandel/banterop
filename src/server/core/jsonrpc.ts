import type { Context } from 'hono'
export const e = { PARSE_ERROR:-32700, INVALID_REQUEST:-32600, METHOD_NOT_FOUND:-32601, INVALID_PARAMS:-32602, SERVER_ERROR:-32000 } as const

export async function parseRpc(c: Context) {
  if (!(c.req.header('content-type') || '').includes('application/json')) return null
  const body = await c.req.json()
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return null
  return body as { jsonrpc:'2.0', id?: string|number|null, method:string, params?: any }
}

export function rpcError(code:number, message:string, id?: any) {
  return { jsonrpc:'2.0', id: id ?? null, error: { code, message } }
}

