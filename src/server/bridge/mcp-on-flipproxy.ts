// src/server/bridge/mcp-on-flipproxy.ts
//
// MCP adapter on top of FlipProxy (A2A) — initiator-side only.
//
// Endpoint: POST /api/bridge/:pairId/mcp
// - Same process and port as flipproxy.ts; just another route.
// - Uses MCP SDK's Streamable HTTP transport, but runs on Bun/Hono via a tiny adapter.
//
// Tools (per Option 1 — MCP):
//   begin_chat_thread() → { conversationId: string }
//   send_message_to_chat_thread({ conversationId, message, attachments? }) → { guidance, status: "working" }
//   check_replies({ conversationId, waitMs?=10000 }) → {
//     messages: [{ from: "administrator", at, text, attachments: [{ name, contentType, content, summary? }] }],
//     guidance, status: "working" | "input-required" | "completed", conversation_ended: boolean
//   }
//
// Notes
// - conversationId == current epoch's initiator task id (e.g., "init:<pairId>#<epoch>").
// - begin_chat_thread does NOT create a new pair. It ensures a new epoch exists if needed.
// - This adapter uses FlipProxy’s in-memory pair -> task state, so responders continue to work normally
//   via the A2A responder flow.
// - Attachments are expanded inline (string content) in check_replies output.
//
// Integration:
//   1) Ensure flipproxy.ts exports: mustPairAsync, onIncomingMessage, newTask, and (optionally) Role/TaskState types.
//   2) In flipproxy.ts after `const app = new Hono()` and before `serve({...})`, call:
//        import { registerFlipProxyMcpBridge } from './bridge/mcp-on-flipproxy';
//        registerFlipProxyMcpBridge(app);
//   3) Install deps: `@modelcontextprotocol/sdk` and `zod`.
//
// ----------------------------------------------------------------------

import type { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import type { A2APart } from '../../shared/a2a-types';

// Import minimal FlipProxy helpers (export them from flipproxy.ts)
import { mustPairAsync, onIncomingMessage, newTask } from '../flipproxy';

// ------------------------------
// Public entry: register route
// ------------------------------

export function registerFlipProxyMcpBridge(app: Hono) {
  // One route, scoped to an existing pair
  app.post('/api/bridge/:pairId/mcp', async (c) => {
    const pairId = c.req.param('pairId');
    // Build an MCP server instance bound to this pair
    const server = await buildMcpServerForPair(pairId);

    // Use a streamable HTTP transport, but run it over Bun/Hono via a tiny adapter
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true, // reply as JSON when not streaming; perfect for tool calls
    });

    await server.connect(transport);

    // Adapt the fetch-style Request/Response to the MCP SDK's Node-style handleRequest
    const inputBody = await c.req.arrayBuffer(); // raw body for the transport
    const { res } = createNodeResponseCollector();
    const req = createNodeIncomingMessageFromFetch(c.req, inputBody);

    await transport.handleRequest(req as any, res as any, Buffer.from(inputBody));

    // Build a Response from what the transport wrote to our collector
    return res.toFetchResponse();
  });
}

// ------------------------------
// MCP server bound to a pair
// ------------------------------

async function buildMcpServerForPair(pairId: string): Promise<McpServer> {
  const s = new McpServer({ name: 'flipproxy-mcp', version: '0.1.0' });

  // --- Tool: begin_chat_thread ---
  // Ensures we have an active epoch with tasks; returns the initiator task id as conversationId
  s.registerTool(
    'begin_chat_thread',
    { inputSchema: {}, description: `Begin a chat thread for pair ${pairId}. (No new pair created.)` },
    async () => {
      const { initiatorTaskId } = await ensureEpochTasksForPair(pairId);
      const obj = { conversationId: String(initiatorTaskId) };
      return jsonContent(obj);
    }
  );

  // --- Tool: send_message_to_chat_thread ---
  s.registerTool(
    'send_message_to_chat_thread',
    {
      inputSchema: {
        conversationId: z.string(),
        message: z.string(),
        attachments: z
          .array(
            z.object({
              name: z.string(),
              contentType: z.string(),
              content: z.string(), // textual content (adapter encodes to base64); You can extend if you want raw base64 here.
              summary: z.string().optional(),
            })
          )
          .optional(),
      },
      description: `Send a message as the initiator for pair ${pairId} (finality='turn').`,
    },
    async (params: any) => {
      const conversationId = String(params?.conversationId ?? '');
      const message = String(params?.message ?? '');
      const attachments = Array.isArray(params?.attachments) ? params.attachments : [];

      if (!conversationId) return jsonContent(bad(`conversationId is required`));
      if (!message && attachments.length === 0) return jsonContent(bad(`message or attachments is required`));

      const p = await mustPairAsync(pairId);
      const tInit = await ensureEpochTasksForPair(pairId).then(r => r.initiatorTaskId);
      if (conversationId !== tInit) {
        // Different epoch than current; for simplicity, reject (keeps correctness obvious)
        return jsonContent(bad(`conversationId does not match current epoch (expected ${tInit})`));
      }

      const parts: A2APart[] = [];
      // Text part with A2A extension (finality hint)
      parts.push({
        kind: 'text',
        text: message,
        metadata: { 'https://chitchat.fhir.me/a2a-ext': { finality: 'turn' } },
      } as any);

      // File parts
      for (const a of attachments) {
        parts.push({
          kind: 'file',
          file: {
            // convert to base64 for A2A "bytes"
            bytes: toBase64(String(a.content ?? '')),
            name: String(a.name ?? ''),
            mimeType: String(a.contentType ?? 'application/octet-stream'),
          },
          // Let summary ride in metadata if provided
          ...(a.summary ? { metadata: { summary: a.summary } } : {}),
        } as any);
      }

      const messageId = `m:${crypto.randomUUID()}`;
      onIncomingMessage(p, 'initiator', { parts, messageId });

      const obj = {
        guidance:
          'Message sent. Use check_replies (e.g., waitMs=10000) to fetch replies from the responder.',
        status: 'working' as const,
      };
      return jsonContent(obj);
    }
  );

  // --- Tool: check_replies ---
  s.registerTool(
    'check_replies',
    {
      inputSchema: {
        conversationId: z.string(),
        waitMs: z.number().default(10000),
      },
      description: `Poll for replies from the responder since your last initiator message.`,
    },
    async (params: any) => {
      const waitMs = Number(params?.waitMs ?? 10000);
      const conversationId = String(params?.conversationId ?? '');
      if (!conversationId) return jsonContent(bad(`conversationId is required`));

      const p = await mustPairAsync(pairId);
      const ensured = await ensureEpochTasksForPair(pairId);
      if (conversationId !== ensured.initiatorTaskId) {
        // If caller is on an old epoch, report completion (simple, clear semantics)
        return jsonContent({
          messages: [],
          guidance:
            'Your conversation id refers to a previous epoch. The current epoch is different; consider starting again.',
          status: 'completed' as const,
          conversation_ended: true,
        });
      }

      const init = (p as any).initiatorTask as any;
      const resp = (p as any).responderTask as any;

      // Collect replies since the last initiator-authored message in initiator task history
      async function collect(): Promise<ReturnType<typeof simplifyReplies>> {
        const replies = repliesSinceLastInitiatorUserMessage(init);
        const simplified = simplifyReplies(p, replies);
        const status = computeStatus(p);
        const guidance = computeGuidance(p, status);
        const ended = status === 'completed';
        return { simplified, status, guidance, ended };
      }

      let { simplified, status, guidance, ended } = await collect();

      // If none yet and wait requested, long-poll for new mirrored messages onto the initiator task
      if (!ended && simplified.messages.length === 0 && waitMs > 0) {
        const got = await waitForNextAgentMessageOnInitiator(init, waitMs);
        if (got) {
          const out = await collect();
          simplified = out.simplified;
          status = out.status;
          guidance = out.guidance;
          ended = out.ended;
        } else {
          // Still nothing
          status = 'working';
          guidance = 'No new replies yet. Call check_replies again.';
          ended = false;
        }
      }

      return jsonContent({
        messages: simplified.messages,
        guidance,
        status,
        conversation_ended: ended,
      });
    }
  );

  return s;
}

// ------------------------------
// FlipProxy linkage helpers
// ------------------------------

/**
 * Ensure there are tasks for the current epoch (no message is sent).
 * Returns initiator task id that acts as the MCP conversationId.
 */
async function ensureEpochTasksForPair(pairId: string): Promise<{ initiatorTaskId: string }> {
  const p = await mustPairAsync(pairId);
  // If tasks exist, keep them; otherwise create a new epoch like A2A message/stream does.
  if (!(p as any).initiatorTask || !(p as any).responderTask) {
    (p as any).epoch = ((p as any).epoch ?? 0) + 1;
    (p as any).turn = (p as any).startingTurn || 'initiator';
    (p as any).initiatorTask = newTask(pairId, 'initiator', `init:${pairId}#${(p as any).epoch}`);
    (p as any).responderTask = newTask(pairId, 'responder', `resp:${pairId}#${(p as any).epoch}`);
    // Emit concise events matching flipproxy style
    logEventCompat(p, { type: 'epoch-begin', epoch: (p as any).epoch });
    const ev = {
      type: 'subscribe',
      pairId,
      epoch: (p as any).epoch,
      taskId: (p as any).responderTask.id,
      turn: (p as any).turn,
    };
    // backchannel notify responders
    try { ((p as any).serverEvents as Set<(ev: any) => void>).forEach(fn => fn(ev)); } catch {}
    logEventCompat(p, { type: 'backchannel', action: 'subscribe', epoch: (p as any).epoch, taskId: (p as any).responderTask.id, turn: (p as any).turn });
  }
  return { initiatorTaskId: String((p as any).initiatorTask.id) };
}

/**
 * Replies on initiator task since the most recent initiator-authored user message.
 * We use initiatorTask.history only (mirrored agent messages appear there as role='agent').
 */
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

/** Simplify A2A mirrored 'agent' messages into MCP return shape (attachments inlined). */
function simplifyReplies(p: any, msgs: any[]): {
  messages: Array<{ from: string; at: string; text: string; attachments?: Array<{ name: string; contentType: string; content: string; summary?: string }> }>
} {
  const out: Array<{ from: string; at: string; text: string; attachments?: Array<{ name: string; contentType: string; content: string; summary?: string }> }> = [];
  for (const m of msgs) {
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    const text = parts.filter((pp: any) => pp?.kind === 'text').map((pp: any) => String(pp.text || '')).join('\n');
    const attachments: Array<{ name: string; contentType: string; content: string; summary?: string }> = [];
    for (const pp of parts) {
      if (pp?.kind === 'file' && pp.file && typeof pp.file === 'object' && 'bytes' in pp.file) {
        const name = String(pp.file?.name || 'file.bin');
        const contentType = String(pp.file?.mimeType || 'application/octet-stream');
        const content = fromBase64(String((pp.file as any).bytes || '')); // expand inline
        const summary = (pp as any)?.metadata?.summary ? String((pp as any).metadata.summary) : undefined;
        attachments.push({ name, contentType, content, ...(summary ? { summary } : {}) });
      }
    }
    const at = findEventTsByMessageId(p, String(m?.messageId || '')) || new Date().toISOString();
    out.push({ from: 'administrator', at, text, ...(attachments.length ? { attachments } : {}) });
  }
  return { messages: out };
}

/** Compute status for MCP output (working | input-required | completed) from pair state. */
function computeStatus(p: any): 'working' | 'input-required' | 'completed' {
  const i = (p as any).initiatorTask, r = (p as any).responderTask;
  const completed = (i?.status === 'completed') || (r?.status === 'completed') || (i?.status === 'canceled') || (r?.status === 'canceled') || (i?.status === 'failed') || (r?.status === 'failed');
  if (completed) return 'completed';
  const turn = (p as any).turn || 'initiator';
  return turn === 'initiator' ? 'input-required' : 'working';
}

/** Natural-sounding guidance string based on status. */
function computeGuidance(p: any, status: 'working' | 'input-required' | 'completed'): string {
  if (status === 'completed') return 'Conversation ended. No further input is expected.';
  if (status === 'input-required') return `It’s your turn to respond as initiator. You can send a message now.`;
  return 'Waiting for the responder to finish or reply. Call check_replies again.';
}

// Wait for the next mirrored agent message on initiator task (long-poll)
function waitForNextAgentMessageOnInitiator(initTask: any, waitMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; try { subs.delete(sub); } catch {} resolve(false); }
    }, Math.max(0, waitMs));
    const subs: Set<(frame: any) => void> = initTask?.subscribers || new Set();
    const sub = (frame: any) => {
      try {
        // Only resolve on a mirrored agent message
        if (frame && frame.result && frame.result.kind === 'message' && frame.result.role === 'agent') {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            try { subs.delete(sub); } catch {}
            resolve(true);
          }
        }
      } catch {
        // ignore
      }
    };
    try { subs.add(sub); } catch {}
  });
}

// Find 'ts' for a messageId from the concise event log (flipproxy keeps eventHistory with seq + ev)
function findEventTsByMessageId(p: any, messageId: string): string | undefined {
  try {
    const hist: Array<{ seq: number; ev: any }> = (p as any).eventHistory || [];
    for (let i = hist.length - 1; i >= 0; --i) {
      const row = hist[i];
      if (row?.ev?.type === 'message' && row?.ev?.messageId === messageId) {
        return String(row.ev.ts || '');
      }
    }
  } catch {}
  return undefined;
}

// Append an event to the pair’s concise log (minimal compatible implementation)
function logEventCompat(p: any, ev: any): void {
  try {
    if (typeof (p as any).eventSeq !== 'number') (p as any).eventSeq = 0;
    if (!Array.isArray((p as any).eventHistory)) (p as any).eventHistory = [];
    const seq = ++(p as any).eventSeq;
    const payload = { ts: new Date().toISOString(), pairId: String((p as any).id || ''), seq, ...ev };
    (p as any).eventHistory.push({ seq, ev: payload });
    // fan out live listeners (control plane tails)
    try {
      const listeners: Set<(x: any) => void> = (p as any).eventLog || new Set();
      listeners.forEach(fn => { try { fn(payload); } catch {} });
    } catch {}
    // trim cap (match flipproxy’s default if available)
    const cap = 1000;
    const over = ((p as any).eventHistory.length || 0) - cap;
    if (over > 0) (p as any).eventHistory.splice(0, over);
    (p as any).lastActivityMs = Date.now();
  } catch {}
}

// ------------------------------
// Utilities
// ------------------------------

function toBase64(s: string): string {
  // Node/Bun path
  // eslint-disable-next-line no-undef
  return Buffer.from(s, 'utf-8').toString('base64');
}
function fromBase64(b64: string): string {
  // eslint-disable-next-line no-undef
  return Buffer.from(b64, 'base64').toString('utf-8');
}

function bad(message: string) {
  return { ok: false, error: message };
}
function jsonContent(obj: unknown) {
  // MCP SDK expects { content:[{type:'text',text:...}], structuredContent: ... }
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj } as any;
}

// ------------------------------
// Tiny Request/Response adapter
// ------------------------------
//
// The MCP SDK transport expects Node's IncomingMessage/ServerResponse.
// This adapter lets us reuse it under Bun/Hono without another server.
//

function createNodeIncomingMessageFromFetch(req: Request, body: ArrayBuffer) {
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));

  const nodeReq = {
    method: req.method,
    url: url.pathname + url.search,
    headers,
    // minimal read interface if transport inspects the body stream; we pass body separately anyway
    // but provide stubs to be safe
    socket: {},
    connection: {},
  };
  return nodeReq;
}

function createNodeResponseCollector() {
  let statusCode = 200;
  const headers = new Map<string, string>();
  const chunks: Uint8Array[] = [];
  let ended = false;

  const res = {
    setHeader(k: string, v: string) { headers.set(k, v); },
    getHeader(k: string) { return headers.get(k); },
    writeHead(sc: number, hs?: Record<string, string>) {
      statusCode = sc;
      if (hs) for (const [k, v] of Object.entries(hs)) headers.set(k, String(v));
    },
    write(chunk: any) {
      if (ended) return;
      if (typeof chunk === 'string') chunks.push(new TextEncoder().encode(chunk));
      else if (chunk instanceof Uint8Array) chunks.push(chunk);
      else if (chunk != null) chunks.push(new TextEncoder().encode(String(chunk)));
    },
    end(chunk?: any) {
      if (ended) return;
      if (chunk != null) res.write(chunk);
      ended = true;
    },
    toFetchResponse(): Response {
      const body = chunks.length ? concat(chunks) : new Uint8Array();
      const h = new Headers();
      headers.forEach((v, k) => h.set(k, v));
      return new Response(body, { status: statusCode, headers: h });
    },
  };
  return { res };
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

