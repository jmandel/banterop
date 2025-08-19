import type { TaskClientLike, TaskClientEventType } from "./task-client";
import type { A2APart, A2ATask, A2AStatus, A2AMessage } from "../a2a-types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type McpReply = { role?: string; text?: string; attachments?: any[] };

function utf8ToBase64(s: string): string {
  try {
    const enc = new TextEncoder().encode(s ?? "");
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < enc.length; i += chunk) {
      bin += String.fromCharCode(...enc.subarray(i, i + chunk));
    }
    return btoa(bin);
  } catch {
    return btoa(encodeURIComponent(s).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  }
}

function base64ToUtf8(b64: string): string {
  try {
    const bin = atob(b64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    // Fallback: attempt naive atob to string
    try { return atob(b64 || ''); } catch { return ''; }
  }
}

function normalizePartsForMcp(parts: A2APart[]): { text: string; attachments: any[] } {
  const texts = (Array.isArray(parts) ? parts : [])
    .filter((p: any) => p?.kind === 'text')
    .map((p: any) => String(p.text || ''));
  const attachments = (Array.isArray(parts) ? parts : [])
    .filter((p: any) => p?.kind === 'file' && p?.file)
    .map((p: any) => {
      const name = String(p.file?.name || 'attachment');
      const contentType = String(p.file?.mimeType || 'application/octet-stream');
      const bytes = typeof p.file?.bytes === 'string' ? p.file.bytes : undefined;
      if (!bytes) return null;
      // Always decode base64 bytes to UTF-8 text for MCP tool APIs requiring plain string "content"
      const content = base64ToUtf8(bytes);
      return { name, contentType, content };
    })
    .filter(Boolean) as any[];
  return { text: texts.join('\n').trim(), attachments };
}

export class McpTaskClient implements TaskClientLike {
  private listeners = new Map<TaskClientEventType, Set<(ev: any) => void>>();
  private conversationId?: string;
  private status: A2AStatus | "initializing" = "initializing";
  private history: A2AMessage[] = [];
  private dead = false;
  private client: Client | null = null;
  private lastEmitted: { count: number; status: A2AStatus | "initializing" } = { count: 0, status: "initializing" };
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // naive de-dupe for replies when server lacks ids
  private seenHashes = new Set<string>();

  constructor(private endpointUrl: string) {}

  on<T = any>(eventType: TaskClientEventType, cb: (ev: T) => void): () => void {
    if (!this.listeners.has(eventType)) this.listeners.set(eventType, new Set());
    const set = this.listeners.get(eventType)!;
    set.add(cb as any);
    return () => set.delete(cb as any);
  }
  private emit(type: TaskClientEventType, data: any) {
    const set = this.listeners.get(type);
    if (set) for (const cb of set) { try { (cb as any)(data); } catch {} }
  }

  getTask(): A2ATask | null {
    if (!this.conversationId) return null;
    return {
      id: this.conversationId,
      contextId: this.conversationId,
      status: { state: this.status },
      history: this.history,
      kind: "task",
      metadata: {}
    } as any;
  }
  getTaskId(): string | undefined { return this.conversationId; }
  getStatus(): A2AStatus | "initializing" { return this.status; }

  async resume(taskId: string) {
    this.conversationId = String(taskId);
    await this.ensureConnected();
    await this.pollOnce();
    this.ensurePolling();
    this.emit("new-task", this.getTask());
  }

  async startNew(parts: A2APart[]) {
    await this.ensureConnected();
    if (!this.conversationId) {
      const res = await this.client!.callTool({ name: "begin_chat_thread", arguments: {} });
      const content = (res as any)?.content || [];
      const text = (Array.isArray(content) ? content.find((c: any) => c?.type === 'text')?.text : undefined) || '';
      try {
        const obj = JSON.parse(text);
        this.conversationId = String(obj?.conversationId || obj?.id || '');
      } catch {}
      if (!this.conversationId) throw new Error("MCP: no conversationId");
    }
    await this.send(parts);
  }

  async send(parts: A2APart[]) {
    await this.ensureConnected();
    if (!this.conversationId) {
      await this.startNew(parts);
      return;
    }
    const { text, attachments } = normalizePartsForMcp(parts);
    await this.client!.callTool({
      name: "send_message_to_chat_thread",
      arguments: {
        conversationId: this.conversationId,
        message: text,
        ...(attachments.length ? { attachments } : {})
      }
    });

    // optimistic append (as "user")
    const messageId = crypto.randomUUID();
    const msg: A2AMessage = {
      role: "user",
      parts,
      messageId,
      taskId: this.conversationId,
      kind: "message"
    } as any;
    this.history = [...this.history, msg];
    this.status = "working";
    this.emitIfChanged();

    await this.pollOnce();
    this.ensurePolling();
  }

  async cancel(): Promise<void> {
    this.dead = true;
    this.status = "canceled";
    this.emit("new-task", this.getTask());
    this.stopPolling();
  }

  clearLocal(): void {
    this.dead = true;
    this.conversationId = undefined;
    this.status = "initializing";
    this.history = [];
    this.seenHashes.clear();
    this.stopPolling();
  }

  // Hard shutdown: stop polling and close underlying MCP client/transport
  destroy(): void {
    try { this.stopPolling(); } catch {}
    this.dead = true;
    this.conversationId = undefined;
    this.status = "initializing";
    this.history = [];
    this.seenHashes.clear();
    try { (this.client as any)?.close?.(); } catch {}
    this.client = null;
  }

  // ---- internals ----
  private async ensureConnected() {
    if (this.client) return;
    const url = (() => {
      try { return new URL(this.endpointUrl); }
      catch { try { return new URL(this.endpointUrl, (typeof window !== 'undefined' ? window.location.href : 'http://localhost')); } catch { return new URL('http://localhost'); } }
    })();
    // Provide a fetch override that tells the transport "no SSE GET" with 405 to avoid servers that don't implement GET.
    const transport = new StreamableHTTPClientTransport(url as any, {
      fetch: async (input: any, init?: RequestInit) => {
        if ((init?.method || 'GET').toUpperCase() === 'GET') {
          return new Response('', { status: 405 });
        }
        return fetch(input, init);
      }
    } as any);
    const client = new Client({ name: "conversational-interop-client", version: "1.0.0" });
    await client.connect(transport);
    this.client = client;
  }

  private async pollOnce() {
    if (!this.conversationId || !this.client) return;
    try {
      const res = await this.client.callTool({
        name: "check_replies",
        arguments: { conversationId: this.conversationId, waitMs: 10000 }
      });
      const content = (res as any)?.content || [];
      const text = (Array.isArray(content) ? content.find((c: any) => c?.type === 'text')?.text : undefined) || '';
      let obj: any = {};
      try { obj = JSON.parse(text); } catch {}
      // Accept both { replies: [...] } and { messages: [...] } shapes
      const replies: any[] = Array.isArray(obj?.replies)
        ? obj.replies
        : Array.isArray(obj?.messages)
          ? obj.messages
          : [];
      const status: string = String(obj?.status || '').toLowerCase();
      const ended: boolean = obj?.conversation_ended === true || obj?.ended === true;

      let appended = 0;
      for (const r of replies) {
        const key = JSON.stringify(r);
        if (this.seenHashes.has(key)) continue;
        this.seenHashes.add(key);
        const parts: A2APart[] = [] as any;
        const t = String((r?.text ?? r?.message ?? '') || '');
        if (t) parts.push({ kind: 'text', text: t } as any);
        const atts = Array.isArray(r?.attachments) ? r.attachments : Array.isArray(r?.files) ? r.files : [];
        for (const a of atts) {
          const name = String(a?.name || 'attachment');
          const mimeType = String(a?.mimeType || a?.contentType || 'application/octet-stream');
          const bytes = typeof a?.bytes === 'string'
            ? a.bytes
            : (typeof a?.content === 'string' ? utf8ToBase64(a.content) : undefined);
          const uri = typeof a?.uri === 'string' ? a.uri : undefined;
          parts.push({ kind: 'file', file: { name, mimeType, ...(bytes ? { bytes } : {}), ...(uri ? { uri } : {}) } } as any);
        }
        const msg: A2AMessage = {
          // Treat replies/messages from server as agent
          role: (String(r?.role || r?.from || 'assistant') === 'user') ? 'user' : 'agent',
          parts,
          messageId: crypto.randomUUID(),
          taskId: this.conversationId!,
          kind: "message"
        } as any;
        this.history = [...this.history, msg];
        appended++;
      }

      if (ended) this.status = "completed";
      else if (status === "input_required" || status === "input-required") this.status = "input-required";
      else if (status === "waiting" || status === "working" || status === "pending") this.status = "working";

      this.emitIfChanged(appended > 0);
      // Stop polling while waiting for user input; restart when we send next message
      // Also stop when conversation is complete or otherwise terminal.
      if (this.status === "input-required" || this.status === "completed" || this.status === "failed" || this.status === "canceled") {
        this.stopPolling();
      }
    } catch (e: any) {
      this.emit("error", { error: String(e?.message ?? e) });
    }
  }

  private ensurePolling() {
    if (this.pollTimer || this.dead) return;
    // Do not start polling if already in a terminal state
    if (this.status === "completed" || this.status === "failed" || this.status === "canceled") return;
    this.pollTimer = setInterval(() => {
      if (this.dead || !this.conversationId) {
        this.stopPolling();
        return;
      }
      // Only poll when we might be expecting messages or to reflect status transitions
      this.pollOnce();
    }, 1200);
  }

  private stopPolling() {
    if (this.pollTimer) {
      try { clearInterval(this.pollTimer); } catch {}
      this.pollTimer = null;
    }
  }

  private emitIfChanged(force = false) {
    const count = this.history.length;
    const status = this.status;
    if (!force && count === this.lastEmitted.count && status === this.lastEmitted.status) return;
    this.lastEmitted = { count, status };
    this.emit("new-task", this.getTask());
  }
}
