import type { TransportAdapter, TransportSnapshot, SendOptions } from "./types";
import type { A2APart, A2AMessage, A2AStatus } from "../../shared/a2a-types";
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function pickJsonOrParseText(result: any): any {
  const content = Array.isArray(result?.content) ? result.content : [];
  const jsonItem = content.find((c:any) => c && typeof c === 'object' && 'json' in c);
  if (jsonItem && jsonItem.json != null) return jsonItem.json;
  const txt = String(content?.[0]?.text || '').trim();
  try { return JSON.parse(txt || '{}'); } catch { return {}; }
}

/** MCPAdapter implemented using the official MCP SDK (Streamable HTTP client). */
type WireEntry = { protocol:'a2a'|'mcp'; dir:'inbound'|'outbound'; method?:string; kind?:string; roomId?:string; taskId?:string; messageId?:string; payload:any };

export class MCPAdapter implements TransportAdapter {
  private conversationId: string | undefined;
  private messages: A2AMessage[] = [];
  private status: A2AStatus = 'submitted';
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connecting = false;
  private resumeAfterSend: (() => void) | null = null;
  private lastAgentSig: string | null = null;
  private onWire?: (e: WireEntry) => void;
  private roomId?: string;

  constructor(private endpoint: string, opts?: { onWire?: (e: WireEntry)=>void; roomId?: string }) {
    this.onWire = opts?.onWire;
    this.roomId = opts?.roomId;
  }

  kind(): 'a2a'|'mcp' { return 'mcp'; }

  private ensureMessageId(): string { return `m-${crypto.randomUUID()}`; }

  private buildSnapshot(): TransportSnapshot {
    const latest = this.messages.length ? this.messages[this.messages.length - 1] : undefined;
    return {
      kind: 'task',
      id: this.conversationId || 'conv:pending',
      status: latest ? { state: this.status, message: latest } : { state: this.status },
      history: this.messages.slice(0, Math.max(0, this.messages.length - 1))
    };
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connecting) { while (this.connecting) await new Promise(r=>setTimeout(r,10)); return; }
    this.connecting = true;
    try {
      this.client = new Client({ name: 'banterop-web', version: '0.1.0' });
      const url = new URL(this.endpoint);
      // Provide a fetch wrapper that returns 405 for SSE GET to keep things simple (JSON responses only)
      const fetchWrap = (input: any, init?: any) => {
        const method = String((init?.method || 'GET')).toUpperCase();
        const hdrs = new Headers(init?.headers || {});
        const accept = hdrs.get('accept') || hdrs.get('Accept') || '';
        if (method === 'GET' && accept.includes('text/event-stream')) {
          return Promise.resolve(new Response(null, { status: 405 }));
        }
        if (method === 'POST') {
          hdrs.set('accept', 'application/json, text/event-stream');
          hdrs.set('content-type', 'application/json');
          init = { ...init, headers: hdrs };
        }
        return (globalThis.fetch as any)(input, init);
      };
      this.transport = new StreamableHTTPClientTransport(url, { requestInit: {}, fetch: fetchWrap });
      await this.client.connect(this.transport);
    } finally { this.connecting = false; }
  }

  private async callTool(name: string, args?: any): Promise<any> {
    await this.ensureConnected();
    // Log outbound call strictly before sending
    try { this.onWire && this.onWire({ protocol:'mcp', dir:'outbound', method:name, kind:'request', roomId:this.roomId, payload: { name, arguments: args || {} } }); } catch {}
    const result: any = await this.client!.callTool({ name, arguments: args || {} } as any);
    const parsed = pickJsonOrParseText(result);
    // Log inbound result immediately after
    try { this.onWire && this.onWire({ protocol:'mcp', dir:'inbound', method:name, kind:'response', roomId:this.roomId, payload: { name, result: parsed } }); } catch {}
    return parsed;
  }

  async *ticks(taskId: string, signal?: AbortSignal): AsyncGenerator<void> {
    while (!signal?.aborted) {
      try {
        await this.ensureConnected();
        const params = { conversationId: this.conversationId, waitMs: 10000 };
        const out = await this.callTool('check_replies', params);
        const msgs = Array.isArray(out?.messages) ? out.messages : [];
        let any = false;
        for (const m of msgs) {
          const id = this.ensureMessageId();
          const parts: A2APart[] = [];
          const text = typeof m.text === 'string' ? m.text : '';
          if (text) parts.push({ kind: 'text', text });
          const atts = Array.isArray(m.attachments) ? m.attachments : [];
          const sig = JSON.stringify({ text, atts: atts.map((a:any)=>({ name:a?.name||'', ct:a?.contentType||'', c:a?.content||'' })) });
          if (sig && this.lastAgentSig === sig) continue;
          for (const a of atts) {
            const name = a?.name || `file-${Math.random().toString(36).slice(2,7)}`;
            const mime = a?.contentType || 'text/plain';
            const content = typeof a?.content === 'string' ? a.content : JSON.stringify(a?.content ?? {});
            const b64 = btoa(unescape(encodeURIComponent(content)));
            parts.push({ kind: 'file', file: { bytes: b64, name, mimeType: mime } });
          }
          this.messages.push({ role:'agent', parts, messageId: id, kind:'message', contextId: this.conversationId, taskId: this.conversationId });
          this.lastAgentSig = sig;
          any = true;
        }
        const st = String(out?.status || '').replace('_','-') as A2AStatus;
        if (st) this.status = st;
        if (any) yield;
        if (out?.conversation_ended) { this.status = 'completed'; yield; break; }
        // Pause polling while it's our turn to speak to avoid duplicate deliveries
        if (this.status === 'input-required') {
          // Yield once so UI can render the new status
          yield;
          await this.waitForNextSendOrAbort(signal);
        }
      } catch {
        await new Promise(r=>setTimeout(r, 800));
      }
    }
  }

  async snapshot(taskId: string): Promise<TransportSnapshot | null> {
    if (!this.conversationId) return null;
    return this.buildSnapshot();
  }

  async send(parts: A2APart[], opts: SendOptions): Promise<{ taskId: string; snapshot: TransportSnapshot }> {
    await this.ensureConnected();
    if (!this.conversationId) {
      const req0 = {};
      const res = await this.callTool('begin_chat_thread', req0);
      this.conversationId = res?.conversationId || `conv-${crypto.randomUUID()}`;
      this.status = 'submitted';
    }
    const text = (parts || []).filter(p => p.kind === 'text').map((p:any)=>p.text).join("\n");
    const attachments = (parts || []).filter(p => p.kind === 'file').map((p:any) => {
      const name = p?.file?.name || `file-${Math.random().toString(36).slice(2,7)}.txt`;
      const mimeType = p?.file?.mimeType || 'text/plain';
      let content = '';
      if (p?.file && 'bytes' in p.file) {
        try {
          const bin = atob(p.file.bytes);
          const arr = new Uint8Array(bin.length);
          for (let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
          content = new TextDecoder('utf-8').decode(arr);
        } catch { content = ''; }
      } else {
        content = '[remote file: uri omitted]';
      }
      return { name, contentType: mimeType, content };
    });
    const req = {
      conversationId: this.conversationId,
      message: text,
      attachments
    };
    const res2 = await this.callTool('send_message_to_chat_thread', req);
    const id = opts.messageId || `m-${crypto.randomUUID()}`;
    this.messages.push({ role:'user', parts, messageId: id, kind:'message', contextId: this.conversationId, taskId: this.conversationId });
    this.status = 'working';
    // Resume any paused polling loop
    try { this.resumeAfterSend?.(); } catch {}
    this.resumeAfterSend = null;
    return { taskId: this.conversationId!, snapshot: this.buildSnapshot() };
  }

  async cancel(taskId: string): Promise<void> {
    // Reset local state
    this.messages = [];
    this.status = 'submitted';
    this.conversationId = undefined;

    // Capture references before mutating
    const transport = this.transport as any;
    const client = this.client;

    // Wake any paused long-poll loop waiting for a send
    try { this.resumeAfterSend?.(); } catch {}
    this.resumeAfterSend = null;

    // IMPORTANT: Close the transport to stop keep-alive/retry timers
    try { await transport?.terminateSession?.(); } catch {}
    try { await transport?.close?.(); } catch {}

    // Then close the client
    try { await client?.close(); } catch {}

    this.client = null;
    this.transport = null;
  }

  private waitForNextSendOrAbort(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve(); return; }
      this.resumeAfterSend = () => resolve();
      if (signal) {
        const onAbort = () => { try { resolve(); } catch {}; try { signal.removeEventListener('abort', onAbort); } catch {} };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

function stableJson(v: unknown): string {
  try {
    const seen = new WeakSet();
    const replacer = (_k: string, val: any) => {
      if (val && typeof val === 'object') {
        if (seen.has(val)) return undefined;
        seen.add(val);
        if (!Array.isArray(val)) {
          const obj: Record<string, any> = {};
          for (const k of Object.keys(val).sort()) obj[k] = val[k];
          return obj;
        }
      }
      return val;
    };
    return JSON.stringify(v, replacer, 2);
  } catch { try { return JSON.stringify(v); } catch { return String(v); } }
}
