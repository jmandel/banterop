import type { TransportAdapter, TransportSnapshot, SendOptions } from "./types";
import type { A2APart, A2AMessage, A2AStatus } from "../../shared/a2a-types";

type McpToolResult = { content: Array<{ type?: string; text?: string }>; };

async function callTool(endpoint: string, name: string, input?: any): Promise<any> {
  const body = { jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: input || {} } };
  const res = await fetch(endpoint, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`MCP tool ${name} failed: ${res.status}`);
  const j = await res.json();
  const content = (j?.result?.content || []) as Array<{ text?: string }>;
  const txt = (content[0]?.text || '').trim();
  try { return JSON.parse(txt || '{}'); } catch { return {}; }
}

/** MCPAdapter keeps a small in-memory mirror (no server snapshot exists). */
export class MCPAdapter implements TransportAdapter {
  private conversationId: string | undefined;
  // Synthetic mirror to support A2A-like snapshots
  private messages: A2AMessage[] = [];
  private status: A2AStatus = 'submitted';

  constructor(private endpoint: string) {}

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

  async *ticks(taskId: string, signal?: AbortSignal): AsyncGenerator<void> {
    // Long-poll loop: check_replies (waitMs ~ 10s)
    while (!signal?.aborted) {
      try {
        const out = await callTool(this.endpoint, 'check_replies', { conversationId: this.conversationId, waitMs: 10000 });
        const msgs = Array.isArray(out?.messages) ? out.messages : [];
        let any = false;
        for (const m of msgs) {
          const id = this.ensureMessageId();
          const parts: A2APart[] = [];
          const text = typeof m.text === 'string' ? m.text : '';
          if (text) parts.push({ kind: 'text', text });
          const atts = Array.isArray(m.attachments) ? m.attachments : [];
          for (const a of atts) {
            const name = a?.name || `file-${Math.random().toString(36).slice(2,7)}`;
            const mime = a?.contentType || 'text/plain';
            const content = typeof a?.content === 'string' ? a.content : JSON.stringify(a?.content ?? {});
            const b64 = btoa(unescape(encodeURIComponent(content)));
            parts.push({ kind: 'file', file: { bytes: b64, name, mimeType: mime } });
          }
          this.messages.push({ role:'agent', parts, messageId: id, kind:'message', contextId: this.conversationId, taskId: this.conversationId });
          any = true;
        }
        const st = String(out?.status || '').replace('_','-') as A2AStatus;
        if (st) this.status = st;
        if (any) yield;
        // stop if ended
        if (out?.conversation_ended) {
          this.status = 'completed';
          yield;
          break;
        }
      } catch {
        // backoff a little on errors
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }

  async snapshot(taskId: string): Promise<TransportSnapshot | null> {
    if (!this.conversationId) return null;
    return this.buildSnapshot();
  }

  async send(parts: A2APart[], opts: SendOptions): Promise<{ taskId: string; snapshot: TransportSnapshot }> {
    if (!this.conversationId) {
      const res = await callTool(this.endpoint, 'begin_chat_thread', {});
      this.conversationId = res?.conversationId || `conv-${crypto.randomUUID()}`;
      this.status = 'submitted';
    }
    // Convert to MCP send format
    const text = (parts || []).filter(p => p.kind === 'text').map((p:any)=>p.text).join("\n");
    const attachments = (parts || []).filter(p => p.kind === 'file').map((p:any) => {
      const name = p?.file?.name || `file-${Math.random().toString(36).slice(2,7)}.txt`;
      const mimeType = p?.file?.mimeType || 'text/plain';
      let content = '';
      if ('bytes' in p.file) {
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
    await callTool(this.endpoint, 'send_message_to_chat_thread', {
      conversationId: this.conversationId,
      message: text,
      attachments
    });
    // Update synthetic mirror: add the user message
    const id = opts.messageId || `m-${crypto.randomUUID()}`;
    this.messages.push({ role:'user', parts, messageId: id, kind:'message', contextId: this.conversationId, taskId: this.conversationId });
    this.status = 'working';
    return { taskId: this.conversationId!, snapshot: this.buildSnapshot() };
  }

  async cancel(taskId: string): Promise<void> {
    // Prototype: no cancel on server; just clear local mirror
    this.messages = [];
    this.status = 'submitted';
    this.conversationId = undefined;
  }
}
