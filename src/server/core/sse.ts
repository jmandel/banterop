import type { Context } from 'hono'
type RpcFrame = { jsonrpc:'2.0', id?: string|number|null, result?: any, error?: any }

export async function sse(c: Context, stream: AsyncIterable<any>, opts?:{ rpcId?: any }) {
  const headers = { 'content-type':'text/event-stream', 'cache-control':'no-cache, no-transform', 'connection':'keep-alive' }
  const body = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      const write = (obj:any) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
      try {
        for await (const chunk of stream) {
          const payload = opts?.rpcId != null ? { jsonrpc:'2.0', id: opts.rpcId, result: chunk } : chunk
          write(payload)
        }
      } catch (err) {
        const payload = opts?.rpcId != null ? { jsonrpc:'2.0', id: opts.rpcId, error:{ code:-32000, message:String(err) } } : { error:String(err) }
        write(payload)
      } finally { controller.close() }
    }
  })
  return new Response(body, { status:200, headers })
}
