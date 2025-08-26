// MCP adapter on top of FlipProxy — initiator-only
import type { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { A2APart } from '../../shared/a2a-types';
import { mustPairAsync, onIncomingMessage, newTask } from '../flipproxy';
import { A2A_EXT_URL } from '../../shared/core';

export function registerFlipProxyMcpBridge(app: Hono) {
  app.post('/api/bridge/:pairId/mcp', async (c) => {
    const pairId = c.req.param('pairId');
    const server = await buildMcpServerForPair(pairId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    await server.connect(transport);

    // Hono provides Request via c.req.raw
    const rawReq: Request = (c.req as any).raw || new Request(c.req.url, { method: c.req.method, headers: c.req.header() as any });
    const bodyBuf = await rawReq.arrayBuffer();

    const { res } = createNodeResponseCollector();
    const nodeReq = createNodeIncomingMessageFromFetch(rawReq);

    await transport.handleRequest(nodeReq as any, res as any, Buffer.from(bodyBuf));
    return res.toFetchResponse();
  });
}

async function buildMcpServerForPair(pairId: string): Promise<McpServer> {
  const s = new McpServer({ name: 'flipproxy-mcp', version: '0.1.0' });

  s.registerTool('begin_chat_thread', { inputSchema: { type:'object', properties:{}, additionalProperties:false } as any, description: `Begin chat thread for existing pair ${pairId}` }, async () => {
    const { initiatorTaskId } = await ensureEpochTasksForPair(pairId);
    return jsonContent({ conversationId: String(initiatorTaskId) });
  });

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
    const conversationId = String(params?.conversationId ?? '');
    const message = String(params?.message ?? '');
    const attachments = Array.isArray(params?.attachments) ? params.attachments : [];

    if (!conversationId) return jsonContent({ ok:false, error:'conversationId is required' });
    if (!message && attachments.length===0) return jsonContent({ ok:false, error:'message or attachments is required' });

    const p = await mustPairAsync(pairId);
    const tInit = await ensureEpochTasksForPair(pairId).then(r => r.initiatorTaskId);
    if (conversationId !== tInit) return jsonContent({ ok:false, error:`conversationId does not match current epoch (expected ${tInit})` });

    const parts: A2APart[] = [];
    parts.push({ kind:'text', text: message, metadata: { [A2A_EXT_URL]: { finality: 'turn' } } } as any);
    for (const a of attachments) {
      parts.push({
        kind:'file',
        file: { bytes: toBase64(String(a.content ?? '')), name: String(a.name ?? ''), mimeType: String(a.contentType ?? 'application/octet-stream') },
        ...(a.summary ? { metadata: { summary: String(a.summary) } } : {})
      } as any);
    }

    const messageId = `m:${crypto.randomUUID()}`;
    onIncomingMessage(p as any, 'initiator', { parts, messageId });
    return jsonContent({ guidance: 'Message sent. Call check_replies to fetch replies.', status: 'working' });
  });

  s.registerTool('check_replies', {
    inputSchema: {
      type:'object',
      properties: {
        conversationId: { type:'string' },
        waitMs: { type:'number', default: 10000 }
      },
      required: ['conversationId'],
      additionalProperties: false
    } as any,
    description: 'Poll for replies since your last initiator message.'
  }, async (params: any) => {
    const conversationId = String(params?.conversationId ?? '');
    const waitMs = Number(params?.waitMs ?? 10000);
    if (!conversationId) return jsonContent({ ok:false, error:'conversationId is required' });

    const p = await mustPairAsync(pairId);
    const ensured = await ensureEpochTasksForPair(pairId);
    if (conversationId !== ensured.initiatorTaskId) {
      return jsonContent({ messages: [], guidance: 'Conversation id refers to a previous epoch.', status: 'completed', conversation_ended: true });
    }

    const init = (p as any).initiatorTask;
    async function collect() {
      const replies = repliesSinceLastInitiatorUserMessage(init);
      const simplified = simplifyReplies(p, replies);
      const status = computeStatus(p);
      const guidance = computeGuidance(p, status);
      const ended = status === 'completed';
      return { simplified, status, guidance, ended };
    }

    let { simplified, status, guidance, ended } = await collect();

    if (!ended && simplified.messages.length === 0 && waitMs > 0) {
      const got = await waitForNextAgentMessageOnInitiator(init, waitMs);
      if (got) {
        const out = await collect();
        simplified = out.simplified;
        status = out.status;
        guidance = out.guidance;
        ended = out.ended;
      } else {
        status = 'working';
        guidance = 'No new replies yet. Call check_replies again.';
        ended = false;
      }
    }

    return jsonContent({ messages: simplified.messages, guidance, status, conversation_ended: ended });
  });

  return s;
}

async function ensureEpochTasksForPair(pairId: string): Promise<{ initiatorTaskId: string }> {
  const p = await mustPairAsync(pairId);
  if (!(p as any).initiatorTask || !(p as any).responderTask) {
    (p as any).epoch = ((p as any).epoch ?? 0) + 1;
    (p as any).turn = (p as any).startingTurn || 'initiator';
    (p as any).initiatorTask = newTask(pairId, 'initiator', `init:${pairId}#${(p as any).epoch}`);
    (p as any).responderTask = newTask(pairId, 'responder', `resp:${pairId}#${(p as any).epoch}`);
    logEventCompat(p, { type:'epoch-begin', epoch: (p as any).epoch });
    const ev = { type:'subscribe', pairId, epoch: (p as any).epoch, taskId: (p as any).responderTask.id, turn: (p as any).turn };
    try { ((p as any).serverEvents as Set<(ev:any)=>void>).forEach(fn=>fn(ev)); } catch {}
    logEventCompat(p, { type:'backchannel', action:'subscribe', epoch:(p as any).epoch, taskId:(p as any).responderTask.id, turn:(p as any).turn });
  }
  return { initiatorTaskId: String((p as any).initiatorTask.id) };
}

function repliesSinceLastInitiatorUserMessage(initTask: any): any[] {
  const h: any[] = Array.isArray(initTask?.history) ? initTask.history : [];
  let lastUserIdx = -1;
  for (let i = h.length - 1; i >= 0; --i) {
    const m = h[i];
    if (m?.kind === 'message' && m?.role === 'user') { lastUserIdx = i; break; }
  }
  const replies: any[] = [];
  for (let i = lastUserIdx + 1; i < h.length; i++) {
    const m = h[i];
    if (m?.kind === 'message' && m?.role === 'agent') replies.push(m);
  }
  return replies;
}

function simplifyReplies(p:any, msgs:any[]) {
  const out: Array<{ from:string; at:string; text:string; attachments?: Array<{ name:string; contentType:string; content:string; summary?:string }> }> = [];
  for (const m of msgs) {
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    const text = parts.filter((pp:any)=>pp?.kind==='text').map((pp:any)=>String(pp.text||'')).join('\n');
    const attachments: Array<{ name:string; contentType:string; content:string; summary?:string }> = [];
    for (const pp of parts) {
      if (pp?.kind==='file' && pp.file && typeof pp.file==='object' && 'bytes' in pp.file) {
        const name = String(pp.file?.name || 'file.bin');
        const contentType = String(pp.file?.mimeType || 'application/octet-stream');
        const content = fromBase64(String((pp.file as any).bytes || ''));
        const summary = (pp as any)?.metadata?.summary ? String((pp as any).metadata.summary) : undefined;
        attachments.push({ name, contentType, content, ...(summary?{summary}:{}) });
      }
    }
    const at = findEventTsByMessageId(p, String(m?.messageId || '')) || new Date().toISOString();
    out.push({ from:'administrator', at, text, ...(attachments.length?{attachments}:{}) });
  }
  return { messages: out };
}

function computeStatus(p:any): 'working'|'input-required'|'completed' {
  const i = (p as any).initiatorTask, r = (p as any).responderTask;
  const completed = (i?.status==='completed') || (r?.status==='completed') || (i?.status==='canceled') || (r?.status==='canceled') || (i?.status==='failed') || (r?.status==='failed');
  if (completed) return 'completed';
  const turn = (p as any).turn || 'initiator';
  return turn === 'initiator' ? 'input-required' : 'working';
}

function computeGuidance(p:any, status:'working'|'input-required'|'completed'): string {
  if (status==='completed') return 'Conversation ended. No further input is expected.';
  if (status==='input-required') return 'It’s your turn to respond as initiator. You can send a message now.';
  return 'Waiting for the responder to finish or reply. Call check_replies again.';
}

// Minimal JSON content helper for MCP responses (type-erased for runtime-only use)
function jsonContent(obj: any): any { return obj as any; }

function waitForNextAgentMessageOnInitiator(initTask:any, waitMs:number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => { if (!resolved) { resolved = true; try { subs.delete(sub); } catch{} resolve(false); } }, Math.max(0, waitMs));
    const subs: Set<(frame:any)=>void> = initTask?.subscribers || new Set();
    const sub = (frame:any) => {
      try {
        if (frame && frame.result && frame.result.kind==='message' && frame.result.role==='agent') {
          if (!resolved) { resolved = true; clearTimeout(timer); try { subs.delete(sub); } catch{} resolve(true); }
        }
      } catch {}
    };
    try { subs.add(sub); } catch {}
  });
}

function findEventTsByMessageId(p:any, messageId:string): string | undefined {
  try {
    const hist: Array<{ seq:number; ev:any }> = (p as any).eventHistory || [];
    for (let i = hist.length - 1; i >= 0; --i) {
      const row = hist[i];
      if (row?.ev?.type==='message' && row?.ev?.messageId===messageId) return String(row.ev.ts || '');
    }
  } catch {}
  return undefined;
}

function logEventCompat(p:any, ev:any): void {
  try {
    if (typeof (p as any).eventSeq !== 'number') (p as any).eventSeq = 0;
    if (!Array.isArray((p as any).eventHistory)) (p as any).eventHistory = [];
    const seq = ++(p as any).eventSeq;
    const payload = { ts: new Date().toISOString(), pairId: String((p as any).id || ''), seq, ...ev };
    (p as any).eventHistory.push({ seq, ev: payload });
    try {
      const listeners: Set<(x:any)=>void> = (p as any).eventLog || new Set();
      listeners.forEach(fn => { try { fn(payload); } catch {} });
    } catch {}
    const cap = 1000;
    const over = ((p as any).eventHistory.length || 0) - cap;
    if (over > 0) (p as any).eventHistory.splice(0, over);
    (p as any).lastActivityMs = Date.now();
  } catch {}
}

// utilities
function toBase64(s:string): string { return Buffer.from(s, 'utf-8').toString('base64'); }
function fromBase64(b64:string): string { return Buffer.from(b64, 'base64').toString('utf-8'); }

// Node adapter
function createNodeIncomingMessageFromFetch(req: Request) {
  const url = new URL(req.url);
  const headers: Record<string,string> = {};
  req.headers.forEach((v,k)=>headers[k.toLowerCase()] = v);
  return { method: req.method, url: url.pathname + url.search, headers, socket: {}, connection: {} };
}

function createNodeResponseCollector() {
  let statusCode = 200;
  const headers = new Map<string,string>();
  const chunks: Uint8Array[] = [];
  let ended = false;

  const res = {
    setHeader(k:string, v:string) { headers.set(k, v) },
    getHeader(k:string) { return headers.get(k) },
    writeHead(sc:number, hs?:Record<string,string>) { statusCode = sc; if (hs) Object.entries(hs).forEach(([k,v])=>headers.set(k, String(v))) },
    write(chunk:any) {
      if (ended) return;
      if (typeof chunk === 'string') chunks.push(new TextEncoder().encode(chunk));
      else if (chunk instanceof Uint8Array) chunks.push(chunk);
      else if (chunk != null) chunks.push(new TextEncoder().encode(String(chunk)));
    },
    end(chunk?:any) { if (ended) return; if (chunk != null) res.write(chunk); ended = true; },
    toFetchResponse(): Response {
      const body = concat(chunks);
      const h = new Headers(); headers.forEach((v,k)=>h.set(k,v));
      return new Response(new Blob([body as any]), { status: statusCode, headers: h });
    }
  };
  return { res };
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0; for (const p of parts) len += p.length;
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
