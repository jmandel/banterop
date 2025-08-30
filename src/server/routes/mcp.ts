import { Hono } from 'hono'
import type { AppBindings } from '../index'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { A2A_EXT_URL } from '../../shared/core'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

export function mcpRoutes() {
  const r = new Hono<AppBindings>()

  async function handle(c: any) {
    const { pairId } = c.req.param()
    const server = await buildMcpServerForPair(c, pairId)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)

    const rawReq: Request = (c.req as any).raw || new Request(c.req.url, { method: c.req.method, headers: c.req.header() as any })
    const bodyBuf = await rawReq.arrayBuffer()
    const { res, waitForEnd } = createNodeResponseCollector()
    const nodeReq = createNodeIncomingMessageFromFetch(rawReq)
    // Parse JSON body for transport (expects pre-parsed value if provided)
    let parsed: any = undefined
    try {
      const txt = new TextDecoder('utf-8').decode(bodyBuf)
      parsed = txt ? JSON.parse(txt) : undefined
    } catch {}
    await transport.handleRequest(nodeReq as any, res as any, parsed)
    // Wait until transport writes and ends the response (JSON mode)
    await waitForEnd()
    return res.toFetchResponse()
  }

  // Rooms-based MCP endpoints (POST for JSON-RPC; GET for SSE stream)
  r.post('/rooms/:pairId/mcp', async (c) => handle(c))
  r.get('/rooms/:pairId/mcp', async (c) => handle(c))

  return r
}

async function buildMcpServerForPair(c: any, pairId: string): Promise<McpServer> {
  const s = new McpServer({ name: 'banterop-mcp', version: '0.1.0' })
  const pairs = c.get('pairs')
  const db = c.get('db')
  const events = c.get('events')

  s.registerTool('begin_chat_thread', { inputSchema: {}, description: `Begin chat thread for existing pair ${pairId}` }, async () => {
    const ensured = await pairs.beginNewEpochTasksForPair(pairId)
    // Use short conversation id (epoch only) since pair/room is implicit in URL
    const obj = { conversationId: String(ensured.epoch) }
    return { content: [{ type:'text', text: JSON.stringify(obj) }], structuredContent: obj } as any
  })

  s.registerTool('send_message_to_chat_thread', {
    inputSchema: {
      conversationId: z.string(),
      message: z.string(),
      attachments: z.array(z.object({
        name: z.string(),
        contentType: z.string(),
        content: z.string(),
        summary: z.string().optional(),
      })).optional(),
    },
    description: `Send message as initiator for pair ${pairId}`
  }, async (params: any) => {
    const conversationId = String(params?.conversationId ?? '')
    const message = String(params?.message ?? '')
    const attachments = Array.isArray(params?.attachments) ? params.attachments : []

    if (!conversationId) return jsonContent({ ok:false, error:'conversationId is required' })
    const ensured = await pairs.ensureEpochTasksForPair(pairId)
    const isCurrent = (conversationId === ensured.initiatorTaskId) || (conversationId === String(ensured.epoch))
    if (!isCurrent) return jsonContent({ ok:false, error:`conversationId does not match current epoch (expected ${ensured.epoch})` })

    const parts: any[] = []
    if (message) parts.push({ kind:'text', text: message, metadata: { [A2A_EXT_URL]: { nextState: 'working' } } })
    for (const a of attachments) {
      parts.push({ kind:'file', file:{ bytes: toBase64(String(a.content ?? '')), name: String(a.name ?? ''), mimeType: String(a.contentType ?? 'application/octet-stream') }, ...(a.summary ? { metadata:{ summary: String(a.summary) } } : {}) })
    }
    const messageId = `m:${crypto.randomUUID()}`
    await pairs.messageSend(pairId, { parts, taskId: ensured.initiatorTaskId, messageId })
    const obj = { guidance: 'Message sent. Call check_replies to fetch replies.', status: 'working' as const }
    return { content: [{ type:'text', text: JSON.stringify(obj) }], structuredContent: obj } as any
  })

  s.registerTool('check_replies', {
    inputSchema: { conversationId: z.string(), waitMs: z.number().default(10000) },
    description: 'Poll for replies since your last initiator message.'
  }, async (params:any) => {
    const conversationId = String(params?.conversationId ?? '')
    const waitMs = Number(params?.waitMs ?? 10000)
    if (!conversationId) return jsonContent({ ok:false, error:'conversationId is required' })
    const ensured = await pairs.ensureEpochTasksForPair(pairId)
    const isCurrent = (conversationId === ensured.initiatorTaskId) || (conversationId === String(ensured.epoch))
    if (!isCurrent) {
      return jsonContent({ messages: [], guidance: 'Conversation id refers to a previous epoch.', status: 'completed', conversation_ended: true })
    }

    async function collect() {
      const initId = ensured.initiatorTaskId
      const snap = await pairs.tasksGet(pairId, initId)
      const messages: any[] = []
      try {
        const m = (snap as any)?.status?.message
        // Projected for initiator view: inbound responder messages have role==='agent'
        if (m && m.role === 'agent') {
          const parts = Array.isArray(m.parts) ? m.parts : []
          const text = parts.filter((p:any)=>p?.kind==='text').map((p:any)=>String(p.text||''))?.join('\n') || ''
          const attachments: any[] = []
          for (const p of parts) {
            if (p?.kind==='file' && p.file && typeof p.file==='object' && typeof p.file.bytes==='string') {
              attachments.push({ name: String(p.file.name||'file.bin'), contentType: String(p.file.mimeType||'application/octet-stream'), content: fromBase64(String(p.file.bytes||'')), ...(p.metadata?.summary?{summary:String(p.metadata.summary)}:{}) })
            }
          }
          messages.push({ from:'administrator', at: new Date().toISOString(), ...(text?{text}:{ }), ...(attachments.length?{attachments}:{}) })
        }
      } catch {}
      const st: string = String((snap as any)?.status?.state || 'submitted')
      const completed = ['completed','canceled','failed','rejected'].includes(st)
      const status = completed ? 'completed' : (st === 'input-required' || st === 'submitted' ? 'input-required' : 'working')
      const guidance = completed
        ? 'Conversation ended. No further input is expected.'
        : (status==='input-required'
            ? 'It’s your turn to respond as initiator. You can send a message now.'
            : 'Waiting for the responder to finish or reply. Call check_replies again.')
      return { messages, guidance, status, ended: completed }
    }

    // Anchor our wait at the current tip so we only wait for future events
    let since = (() => {
      try {
        const existing = (events as any).listSince(pairId, 0)
        return Array.isArray(existing) && existing.length ? Number(existing[existing.length - 1].seq || 0) : 0
      } catch { return 0 }
    })()
    const deadline = Date.now() + Math.max(0, waitMs)
    while (true) {
      let { messages, guidance, status, ended } = await collect()
      // Return immediately if ended, if there are messages to deliver,
      // or if it's the initiator's turn (input-required)
      if (ended || (Array.isArray(messages) && messages.length > 0) || status === 'input-required') {
        const obj = { messages, guidance, status, conversation_ended: ended }
        return { content: [{ type:'text', text: JSON.stringify(obj) }], structuredContent: obj } as any
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        const obj = { messages, guidance, status, conversation_ended: ended }
        return { content: [{ type:'text', text: JSON.stringify(obj) }], structuredContent: obj } as any
      }
      since = await waitForNextState(events, pairId, since, remaining)
      // Loop and re-collect
    }
  })

  return s
}

function toBase64(s:string): string { return Buffer.from(s, 'utf-8').toString('base64') }
function fromBase64(b64:string): string { return Buffer.from(b64, 'base64').toString('utf-8') }

async function waitForNextState(events:any, pairId:string, since:number, waitMs:number): Promise<number> {
  const stream = events.stream(pairId, since) as AsyncGenerator<any>
  let observed = since
  let done = false
  const p1 = (async () => {
    for await (const chunk of stream) {
      const seq = Number((chunk as any)?.result?.seq || 0)
      if (seq > observed) observed = seq
      done = true
      break
    }
  })()
  const p2 = new Promise<void>(res => setTimeout(()=>res(), Math.max(0, waitMs)))
  await Promise.race([p1, p2])
  try { await (stream as any)?.return?.() } catch {}
  return observed
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
  const closers: Array<() => void> = []
  let resolveEnd: (() => void) | null = null
  const done = new Promise<void>((res) => { resolveEnd = res })

  const res = {
    setHeader(k:string, v:string) { headers.set(k, v) },
    getHeader(k:string) { return headers.get(k) },
    writeHead(sc:number, hs?:Record<string,string>) { statusCode = sc; if (hs) Object.entries(hs).forEach(([k,v])=>headers.set(k, String(v))); return res },
    flushHeaders() { return res },
    write(chunk:any) {
      if (ended) return
      if (typeof chunk === 'string') chunks.push(new TextEncoder().encode(chunk))
      else if (chunk instanceof Uint8Array) chunks.push(chunk)
      else if (chunk != null) chunks.push(new TextEncoder().encode(String(chunk)))
    },
    end(chunk?:any) { if (ended) return; if (chunk != null) res.write(chunk); ended = true; try { closers.forEach(fn=>fn()) } catch {}; try { resolveEnd && resolveEnd() } catch {} },
    on(event:string, fn:()=>void) { if (event === 'close') closers.push(fn) },
    toFetchResponse(): Response {
      const body = concat(chunks)
      const h = new Headers(); headers.forEach((v,k)=>h.set(k,v))
      return new Response(new Blob([body as any]), { status: statusCode, headers: h })
    }
  }
  return { res, waitForEnd: async () => { if (!ended) await done } }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0; for (const p of parts) len += p.length
  const out = new Uint8Array(len); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

function jsonContent(obj:any): any { return obj as any }
