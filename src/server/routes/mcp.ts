import { Hono } from 'hono'
import type { AppBindings } from '../index'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

export function mcpRoutes() {
  const r = new Hono<AppBindings>()

  r.post('/bridge/:pairId/mcp', async (c) => {
    const { pairId } = c.req.param()
    const server = await buildMcpServerForPair(c, pairId)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)

    const rawReq: Request = (c.req as any).raw || new Request(c.req.url, { method: c.req.method, headers: c.req.header() as any })
    const bodyBuf = await rawReq.arrayBuffer()
    const { res } = createNodeResponseCollector()
    const nodeReq = createNodeIncomingMessageFromFetch(rawReq)
    await transport.handleRequest(nodeReq as any, res as any, Buffer.from(bodyBuf))
    return res.toFetchResponse()
  })

  return r
}

async function buildMcpServerForPair(c: any, pairId: string): Promise<McpServer> {
  const s = new McpServer({ name: 'flipproxy-mcp', version: '0.1.0' })
  const pairs = c.get('pairs')
  const db = c.get('db')
  const events = c.get('events')

  s.registerTool('begin_chat_thread', { inputSchema: { type:'object', properties:{}, additionalProperties:false } as any, description: `Begin chat thread for existing pair ${pairId}` }, async () => {
    const ensured = await pairs.ensureEpochTasksForPair(pairId)
    return jsonContent({ conversationId: String(ensured.initiatorTaskId) })
  })

  s.registerTool('send_message_to_chat_thread', {
    inputSchema: {
      type:'object',
      properties: {
        conversationId: { type:'string' },
        message: { type:'string' },
        attachments: {
          type:'array',
          items: {
            type:'object',
            properties: {
              name: { type:'string' },
              contentType: { type:'string' },
              content: { type:'string' },
              summary: { type:'string' }
            },
            required: ['name','contentType','content'],
            additionalProperties: false
          }
        }
      },
      required: ['conversationId'],
      additionalProperties: false
    } as any,
    description: `Send message as initiator for pair ${pairId}`
  }, async (params: any) => {
    const conversationId = String(params?.conversationId ?? '')
    const message = String(params?.message ?? '')
    const attachments = Array.isArray(params?.attachments) ? params.attachments : []

    if (!conversationId) return jsonContent({ ok:false, error:'conversationId is required' })
    const ensured = await pairs.ensureEpochTasksForPair(pairId)
    if (conversationId !== ensured.initiatorTaskId) return jsonContent({ ok:false, error:`conversationId does not match current epoch (expected ${ensured.initiatorTaskId})` })

    const parts: any[] = []
    if (message) parts.push({ kind:'text', text: message, metadata: { 'https://chitchat.fhir.me/a2a-ext': { finality: 'turn' } } })
    for (const a of attachments) {
      parts.push({ kind:'file', file:{ bytes: toBase64(String(a.content ?? '')), name: String(a.name ?? ''), mimeType: String(a.contentType ?? 'application/octet-stream') }, ...(a.summary ? { metadata:{ summary: String(a.summary) } } : {}) })
    }
    const messageId = `m:${crypto.randomUUID()}`
    await pairs.messageSend(pairId, { parts, taskId: ensured.initiatorTaskId, messageId })
    return jsonContent({ guidance: 'Message sent. Call check_replies to fetch replies.', status: 'working' })
  })

  s.registerTool('check_replies', {
    inputSchema: { type:'object', properties: { conversationId: { type:'string' }, waitMs: { type:'number', default: 10000 } }, required: ['conversationId'], additionalProperties:false } as any,
    description: 'Poll for replies since your last initiator message.'
  }, async (params:any) => {
    const conversationId = String(params?.conversationId ?? '')
    const waitMs = Number(params?.waitMs ?? 10000)
    if (!conversationId) return jsonContent({ ok:false, error:'conversationId is required' })
    const ensured = await pairs.ensureEpochTasksForPair(pairId)
    if (conversationId !== ensured.initiatorTaskId) {
      return jsonContent({ messages: [], guidance: 'Conversation id refers to a previous epoch.', status: 'completed', conversation_ended: true })
    }

    async function collect() {
      const initId = ensured.initiatorTaskId
      const respId = ensured.responderTaskId
      const initRow = db.getTask(initId)
      const respRow = db.getTask(respId)
      const messages: any[] = []
      try {
        const m = respRow?.message ? JSON.parse(respRow.message) : null
        if (m && m.role === 'agent') {
          const text = (m.parts || []).filter((p:any)=>p?.kind==='text').map((p:any)=>String(p.text||'')).join('\n')
          const attachments: any[] = []
          for (const p of (m.parts||[])) if (p?.kind==='file' && p.file && typeof p.file==='object' && typeof p.file.bytes==='string') {
            attachments.push({ name: String(p.file.name||'file.bin'), contentType: String(p.file.mimeType||'application/octet-stream'), content: fromBase64(String(p.file.bytes||'')), ...(p.metadata?.summary?{summary:String(p.metadata.summary)}:{}) })
          }
          messages.push({ from:'administrator', at: new Date().toISOString(), text, ...(attachments.length?{attachments}:{}) })
        }
      } catch {}
      const initState = initRow?.state || 'submitted'
      const respState = respRow?.state || 'submitted'
      const completed = ['completed','canceled','failed','rejected'].includes(initState as any) || ['completed','canceled','failed','rejected'].includes(respState as any)
      const status = completed ? 'completed' : (initState === 'input-required' ? 'input-required' : 'working')
      const guidance = completed ? 'Conversation ended. No further input is expected.' : (status==='input-required' ? 'It’s your turn to respond as initiator. You can send a message now.' : 'Waiting for the responder to finish or reply. Call check_replies again.')
      return { messages, guidance, status, ended: completed }
    }

    let { messages, guidance, status, ended } = await collect()
    if (!ended && messages.length === 0 && waitMs > 0) {
      await waitForNextState(events, pairId, waitMs)
      const out = await collect(); messages = out.messages; guidance = out.guidance; status = out.status; ended = out.ended
    }
    return jsonContent({ messages, guidance, status, conversation_ended: ended })
  })

  return s
}

function toBase64(s:string): string { return Buffer.from(s, 'utf-8').toString('base64') }
function fromBase64(b64:string): string { return Buffer.from(b64, 'base64').toString('utf-8') }

async function waitForNextState(events:any, pairId:string, waitMs:number) {
  const stream = events.stream(pairId, 0) as AsyncIterable<any>
  let done = false
  const p1 = (async () => { for await (const _ of stream) { done = true; break } })()
  const p2 = new Promise<void>(res => setTimeout(()=>res(), Math.max(0, waitMs)))
  await Promise.race([p1, p2]); if (!done) return
}

function createNodeIncomingMessageFromFetch(req: Request) {
  const url = new URL(req.url)
  const headers: Record<string,string> = {}
  req.headers.forEach((v,k)=>headers[k.toLowerCase()] = v)
  return { method: req.method, url: url.pathname + url.search, headers, socket: {}, connection: {} }
}

function createNodeResponseCollector() {
  let statusCode = 200
  const headers = new Map<string,string>()
  const chunks: Uint8Array[] = []
  let ended = false

  const res = {
    setHeader(k:string, v:string) { headers.set(k, v) },
    getHeader(k:string) { return headers.get(k) },
    writeHead(sc:number, hs?:Record<string,string>) { statusCode = sc; if (hs) Object.entries(hs).forEach(([k,v])=>headers.set(k, String(v))) },
    write(chunk:any) {
      if (ended) return
      if (typeof chunk === 'string') chunks.push(new TextEncoder().encode(chunk))
      else if (chunk instanceof Uint8Array) chunks.push(chunk)
      else if (chunk != null) chunks.push(new TextEncoder().encode(String(chunk)))
    },
    end(chunk?:any) { if (ended) return; if (chunk != null) res.write(chunk); ended = true },
    toFetchResponse(): Response {
      const body = concat(chunks)
      const h = new Headers(); headers.forEach((v,k)=>h.set(k,v))
      return new Response(new Blob([body as any]), { status: statusCode, headers: h })
    }
  }
  return { res }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0; for (const p of parts) len += p.length
  const out = new Uint8Array(len); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

function jsonContent(obj:any): any { return obj as any }

