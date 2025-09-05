import { Hono } from 'hono'
import type { AppBindings } from '../index'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { A2A_EXT_URL } from '../../shared/core'
import { utf8ToB64, b64ToUtf8 } from '../../shared/codec'
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

  // Restore explicit schemas (zod) for tools
  s.registerTool('begin_chat_thread', { inputSchema: {}, description: `Begin chat thread for existing pair ${pairId}` }, async () => {
    const ensured = await pairs.beginNewEpochTasksForPair(pairId)
    // Broadcast inbound client wire event (MCP request)
    try {
      const payload = { method: 'tools/call', params: { name: 'begin_chat_thread', arguments: {} } };
      const b64 = utf8ToB64(JSON.stringify(payload));
      events.push(pairId, { type: 'client-wire-event', protocol:'mcp', dir:'inbound', tool:'begin_chat_thread', payload: b64, conversationId: String(ensured.epoch), epoch: ensured.epoch } as any)
    } catch {}
    // Use short conversation id (epoch only) since pair/room is implicit in URL
    const obj = { conversationId: String(ensured.epoch) }
    const res = { content: [{ type:'text', text: JSON.stringify(obj) }], structuredContent: obj } as any
    // Broadcast outbound client wire event (MCP response)
    try {
      const b64 = utf8ToB64(JSON.stringify(res));
      events.push(pairId, { type: 'client-wire-event', protocol:'mcp', dir:'outbound', tool:'begin_chat_thread', payload: b64, conversationId: String(ensured.epoch), epoch: ensured.epoch } as any)
    } catch {}
    return res
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
    } as any,
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
    // Broadcast inbound client wire event (MCP request)
    try {
      const payload = { method: 'tools/call', params: { name: 'send_message_to_chat_thread', arguments: { conversationId, message, attachments } } };
      const b64 = utf8ToB64(JSON.stringify(payload));
      events.push(pairId, { type: 'client-wire-event', protocol:'mcp', dir:'inbound', tool:'send_message_to_chat_thread', payload: b64, conversationId, epoch: ensured.epoch } as any)
    } catch {}
    if (message) parts.push({ kind:'text', text: message, metadata: { [A2A_EXT_URL]: { nextState: 'working' } } })
    for (const a of attachments) {
      parts.push({ kind:'file', file:{ bytes: utf8ToB64(String(a.content ?? '')), name: String(a.name ?? ''), mimeType: String(a.contentType ?? 'application/octet-stream') }, ...(a.summary ? { metadata:{ summary: String(a.summary) } } : {}) })
    }
    const messageId = `m:${crypto.randomUUID()}`
    const raw = { conversationId, message, attachments };
    const b64 = utf8ToB64(JSON.stringify(raw));
    // Build a schema-compliant A2A Message for pairs.messageSend
    const m = { kind: 'message', role: 'user', parts, taskId: ensured.initiatorTaskId, messageId } as any
    await pairs.messageSend(pairId, m)
    const obj = { guidance: 'Message sent. Call check_replies to fetch replies.', status: 'working' as const }
    const res = { content: [{ type:'text', text: JSON.stringify(obj) }], structuredContent: obj } as any
    try {
      const b64 = utf8ToB64(JSON.stringify(res));
      events.push(pairId, { type: 'client-wire-event', protocol:'mcp', dir:'outbound', tool:'send_message_to_chat_thread', payload: b64, conversationId, epoch: ensured.epoch } as any)
    } catch {}
    return res
  })

  s.registerTool('check_replies', {
    inputSchema: { conversationId: z.string(), waitMs: z.number().default(10000) } as any,
    description: 'Poll for replies since your last initiator message.'
  }, async (params:any) => {
    const conversationId = String(params?.conversationId ?? '')
    // Sanitize waitMs: finite, non-negative, and capped
    const MAX_WAIT = 120000; // 2 minutes hard cap
    let waitMs = Number(params?.waitMs)
    if (!Number.isFinite(waitMs) || waitMs < 0) waitMs = 10000
    waitMs = Math.min(Math.max(0, waitMs), MAX_WAIT)
    if (!conversationId) return jsonContent({ ok:false, error:'conversationId is required' })
    const ensured = await pairs.ensureEpochTasksForPair(pairId)
    // Broadcast inbound client wire event (MCP request)
    try {
      const payload = { method: 'tools/call', params: { name: 'check_replies', arguments: { conversationId, waitMs } } };
      const b64 = utf8ToB64(JSON.stringify(payload));
      events.push(pairId, { type: 'client-wire-event', protocol:'mcp', dir:'inbound', tool:'check_replies', payload: b64, conversationId, epoch: ensured.epoch } as any)
    } catch {}
    const isCurrent = (conversationId === ensured.initiatorTaskId) || (conversationId === String(ensured.epoch))
    if (!isCurrent) {
      return jsonContent({ messages: [], guidance: 'Conversation id refers to a previous epoch.', status: 'completed', conversation_ended: true })
    }

    async function collect() {
      const initId = ensured.initiatorTaskId
      const snap = await pairs.tasksGet(pairId, initId)
      // Build window: all messages since the last initiator message (role:'user'), projected for initiator
      const hist: any[] = Array.isArray((snap as any)?.history) ? (snap as any).history : []
      const last: any = (snap as any)?.status?.message
      const arr: any[] = [...hist]
      if (last) arr.push(last)

      // Find the most recent initiator message (role:'user')
      let lastUserIdx = -1
      for (let i = arr.length - 1; i >= 0; --i) {
        if (arr[i] && arr[i].role === 'user') { lastUserIdx = i; break }
      }
      const windowMsgs = arr.slice(Math.max(lastUserIdx + 1, 0))
      const messages: any[] = []
      for (const m of windowMsgs) {
        if (!m || m.role !== 'agent') continue
        const parts = Array.isArray(m.parts) ? m.parts : []
        const text = parts.filter((p:any)=>p?.kind==='text').map((p:any)=>String(p.text||''))?.join('\n') || ''
        const attachments: any[] = []
        for (const p of parts) {
          if (p?.kind==='file' && p.file && typeof p.file==='object' && typeof p.file.bytes==='string') {
            attachments.push({ name: String(p.file.name||'file.bin'), contentType: String(p.file.mimeType||'application/octet-stream'), content: b64ToUtf8(String(p.file.bytes||'')), ...(p.metadata?.summary?{summary:String(p.metadata.summary)}:{}) })
          }
        }
        messages.push({ from:'administrator', at: new Date().toISOString(), ...(text?{text}:{ }), ...(attachments.length?{attachments}:{}) })
      }

      const st: string = String((snap as any)?.status?.state || 'submitted')
      const completed = ['completed','canceled','failed','rejected'].includes(st)
      const status = completed ? 'completed' : (st === 'input-required' || st === 'submitted' ? 'input-required' : 'working')
      const guidance = completed
        ? 'Conversation ended. No further input is expected.'
        : (status==='input-required'
            ? 'It’s your turn to respond. You can send a message now.'
            : 'Waiting for the responder to finish or reply. Call check_replies again.')
      const out = { messages, guidance, status, ended: completed }
      try {
        console.debug('[mcp] check_replies.collect', {
          pairId,
          conversationId,
          status,
          ended: completed,
          msgCount: messages.length,
          lastUserIdx,
          windowCount: windowMsgs.length,
        })
      } catch {}
      return out
    }

    // Anchor our wait at the current tip so we only wait for future events
    const since = (() => {
      try {
        const existing = (events as any).listSince(pairId, 0)
        return Array.isArray(existing) && existing.length ? Number(existing[existing.length - 1].seq || 0) : 0
      } catch { return 0 }
    })()
    // First snapshot
    {
      const { messages, guidance, status, ended } = await collect()
      // Return immediately only if terminal or it's the initiator's turn
      if (ended || status === 'input-required') {
        const obj = { messages, guidance, status, conversation_ended: ended }
        try { console.debug('[mcp] check_replies.immediate', { pairId, conversationId, status, ended, msgCount: messages.length }) } catch {}
        const res = { content: [{ type:'text', text: JSON.stringify(obj) }], structuredContent: obj } as any
        try { const b64 = utf8ToB64(JSON.stringify(res)); events.push(pairId, { type: 'client-wire-event', protocol:'mcp', dir:'outbound', tool:'check_replies', payload: b64, conversationId, epoch: ensured.epoch } as any) } catch {}
        return res
      }
    }
    // Wait once (bounded by waitMs), then re-collect and return
    await waitForNextState(events, pairId, since, waitMs)
    {
      const { messages, guidance, status, ended } = await collect()
      const obj = { messages, guidance, status, conversation_ended: ended }
      try { console.debug('[mcp] check_replies.timeoutOrEvent', { pairId, conversationId, status, ended, msgCount: messages.length }) } catch {}
      const res = { content: [{ type:'text', text: JSON.stringify(obj) }], structuredContent: obj } as any
      try { const b64 = utf8ToB64(JSON.stringify(res)); events.push(pairId, { type: 'client-wire-event', protocol:'mcp', dir:'outbound', tool:'check_replies', payload: b64, conversationId, epoch: ensured.epoch } as any) } catch {}
      return res
    }
  })

  return s
}
 

async function waitForNextState(events:any, pairId:string, since:number, waitMs:number): Promise<number> {
  try { if (typeof events.waitUntil === 'function') return await events.waitUntil(pairId, since, waitMs) } catch {}
  // Fallback (shouldn't normally hit): simple timeout return
  await new Promise(res => setTimeout(res, Math.max(0, waitMs)))
  return since
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
