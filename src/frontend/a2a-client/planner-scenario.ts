// Scenario-aware planner (sketch) for A2A client
// Goal: Keep the same UI surface but replace the planning loop
// with a scenario-driven, event-log- and scratchpad-oriented loop.

import { A2ATaskClient } from "./a2a-task-client";
import { AttachmentVault } from "./attachments-vault";
import { ToolSynthesisService } from '$src/agents/services/tool-synthesis.service';
import { BrowserLLMProvider } from './browser-llm-provider';

// Minimal types to keep this self-contained on the browser side
type ScenarioConfiguration = {
  metadata: { id: string; title?: string; background?: string; description?: string };
  agents: Array<{
    agentId: string;
    principal?: { name?: string; description?: string; type?: string };
    systemPrompt?: string;
    situation?: string;
    goals?: string[];
    tools?: Array<{ toolName?: string; name?: string; description?: string }>;
  }>;
};

export type UnifiedEvent = {
  seq: number;
  timestamp: string;
  type: "agent_message" | "trace" | "planner_ask_user" | "user_reply" | "tool_call" | "tool_result";
  agentId: string;
  payload: any;
};

type IntraTurnState = {
  thoughts: string[];
  toolCalls: Array<{ callId: string; name: string; args: any; result?: any }>;
};

type ScenarioPlannerDeps = {
  task: A2ATaskClient;
  vault: AttachmentVault;

  // Fetch API base used by server LLM proxy and scenario endpoints
  getApiBase: () => string; // e.g., http://localhost:3000/api

  // Endpoint URL for A2A; used to decode config64 to find scenario
  getEndpoint: () => string;
  // Selected agent identities (from UI)
  getPlannerAgentId: () => string | undefined;
  getCounterpartAgentId: () => string | undefined;
  getAdditionalInstructions?: () => string | undefined;
  // Enabled tools for synthesis (from UI)
  getEnabledTools?: () => Array<{
    name: string;
    description?: string;
    synthesisGuidance?: string;
    inputSchema?: any;
    endsConversation?: boolean;
    conversationEndStatus?: string;
  }>;

  // UI hooks
  onSystem: (text: string) => void;
  onAskUser: (q: string) => void;
};

export class ScenarioPlannerV2 {
  private running = false;
  private busy = false;
  private pendingTick = false;
  private eventLog: UnifiedEvent[] = [];
  private turnScratch: IntraTurnState = { thoughts: [], toolCalls: [] };
  private scenario: ScenarioConfiguration | null = null;
  private myAgentId: string | null = null;
  private seq = 0;
  private listeners = new Set<(e: UnifiedEvent) => void>();
  private documents = new Map<string, { docId: string; name: string; contentType: string; content?: string; summary?: string }>();
  private oracle: ToolSynthesisService | null = null;

  constructor(private deps: ScenarioPlannerDeps) {}

  // Preload a prior event log (e.g., from persistence) before start()
  loadEvents(events: UnifiedEvent[]) {
    try {
      this.eventLog = Array.isArray(events) ? [...events] : [];
      // Re-index any documents from prior tool_result entries
      for (const ev of this.eventLog) {
        if (ev?.type === 'tool_result') this.indexDocumentsFromResult(ev.payload?.result);
      }
      // Set sequence to the max existing seq to avoid collisions
      const maxSeq = this.eventLog.reduce((m, e) => Math.max(m, Number(e?.seq || 0)), 0);
      this.seq = Number.isFinite(maxSeq) ? maxSeq : this.seq;
    } catch {}
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.seedFromTaskSnapshot();
    this.subscribeTask();
    void this.ensureScenarioLoaded();
    // Try an initial tick right away (will be gated by canActNow)
    this.maybeTick();
  }

  stop() {
    this.running = false;
  }

  recordUserReply(text: string) {
    if (!text?.trim()) return;
    this.pushEvent({ type: "user_reply", agentId: "user", payload: { text } });
    this.maybeTick();
  }

  onEvent(cb: (e: UnifiedEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getEvents(): UnifiedEvent[] { return [...this.eventLog]; }

  private pushEvent(ev: Omit<UnifiedEvent, "seq" | "timestamp">) {
    const event: UnifiedEvent = { ...ev, seq: ++this.seq, timestamp: new Date().toISOString() };
    this.eventLog.push(event);
    try {
      // Observe tool_result to index documents by docId
      if (event.type === 'tool_result') {
        this.indexDocumentsFromResult(event.payload?.result);
      }
      // Notify listeners
      for (const cb of this.listeners) cb(event);
    } catch {}
  }

  private seedFromTaskSnapshot() {
    const t = this.deps.task.getTask();
    if (!t) return;
    const hist = t.history || [];
    const myId = this.deps.getPlannerAgentId();
    const otherId = this.deps.getCounterpartAgentId();
    for (const m of hist) {
      const text = (m.parts || []).filter((p: any) => p?.kind === "text").map((p: any) => p.text).join("\n");
      const attachments = (m.parts || []).filter((p: any) => p?.kind === "file").map((p: any) => ({
        name: p.file?.name,
        contentType: p.file?.mimeType,
        bytes: p.file?.bytes,
        uri: p.file?.uri,
      }));
      const agentId = m.role === "user" ? (myId || "planner") : (otherId || "remote_agent");
      this.pushEvent({ type: "agent_message", agentId, payload: { text, attachments } });
    }
  }

  private subscribeTask() {
    this.deps.task.on("new-task", () => {
      const t = this.deps.task.getTask();
      const last = (t?.history || []).slice(-1)[0];
      if (!last) return;
      const text = (last.parts || []).filter((p: any) => p?.kind === "text").map((p: any) => p.text).join("\n");
      const attachments = (last.parts || []).filter((p: any) => p?.kind === "file").map((p: any) => ({
        name: p.file?.name,
        contentType: p.file?.mimeType,
        bytes: p.file?.bytes,
        uri: p.file?.uri,
      }));
      const myId = this.deps.getPlannerAgentId();
      const otherId = this.deps.getCounterpartAgentId();
      const agentId = last.role === "user" ? (myId || "planner") : (otherId || "remote_agent");
      this.pushEvent({ type: "agent_message", agentId, payload: { text, attachments } });
      this.maybeTick();
    });
  }

  private decodeConfig64FromEndpoint(): { scenarioId?: string; startingAgentId?: string; apiBase: string } | null {
    try {
      const url = this.deps.getEndpoint();
      const m = url.match(/^(https?:\/\/[^\/]+)(?:\/api)?\/bridge\/([^\/]+)\/a2a/);
      if (!m) return { apiBase: this.deps.getApiBase() };
      const apiBase = `${m[1]}/api`;
      const encoded = m[2]!;
      const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
      const bin = atob(normalized + pad);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const json = new TextDecoder().decode(bytes);
      const meta = JSON.parse(json);
      return { scenarioId: meta?.meta?.scenarioId || meta?.scenarioId, startingAgentId: meta?.meta?.startingAgentId || meta?.startingAgentId, apiBase };
    } catch { return { apiBase: this.deps.getApiBase() }; }
  }

  private async ensureScenarioLoaded() {
    const info = this.decodeConfig64FromEndpoint();
    const api = info?.apiBase || this.deps.getApiBase();
    if (!info?.scenarioId) return;
    // Prefer explicit selection
    const explicit = this.deps.getPlannerAgentId();
    this.myAgentId = explicit || info?.startingAgentId || null;
    try {
      const res = await fetch(`${api}/scenarios/${encodeURIComponent(info.scenarioId)}`);
      if (res.ok) {
        const j = await res.json();
        // Accept either a full object with config, or a bare config
        this.scenario = (j && j.config && j.config.agents) ? j.config : j;
      }
    } catch {}
    // After loading scenario, attempt a tick
    this.maybeTick();
  }

  private canActNow(): boolean {
    // Allow if no task yet (first contact) or when status is input-required
    const st = this.deps.task.getStatus();
    const hasTask = !!this.deps.task.getTaskId();
    return !hasTask || st === "input-required";
  }

  private maybeTick() {
    const canAct = this.canActNow();
    const decision = !this.running
      ? 'skip:not_running'
      : this.busy
        ? 'skip:busy'
        : !canAct
          ? 'skip:cant_act'
          : 'proceed';
    try {
      // Log full events object for expandable console inspection
      console.log('[PlannerTick] consider', { events: this.eventLog, running: this.running, busy: this.busy, status: this.deps.task.getStatus(), hasTask: !!this.deps.task.getTaskId() }, 'decision', decision);
    } catch {}
    if (!this.running) return;
    if (this.busy) { this.pendingTick = true; return; }
    if (!canAct) return;
    this.busy = true;
    (async () => {
      try {
        await this.tickOnce();
      } finally {
        this.busy = false;
        if (this.pendingTick) {
          // One-shot re-tick after being busy
          this.pendingTick = false;
          try { console.log('[PlannerTick] after-busy retick'); } catch {}
          this.maybeTick();
        }
      }
    })();
  }

  private buildXmlHistory(): string {
    const lines: string[] = [];
    for (const ev of this.eventLog) {
      if (ev.type === "agent_message") {
        const text = String(ev.payload?.text || "");
        const from = ev.agentId === "planner" ? "planner" : ev.agentId === "remote_agent" ? "agent" : ev.agentId;
        lines.push(`<message from="${from}" at="${ev.timestamp}">${text}</message>`);
        const atts = Array.isArray(ev.payload?.attachments) ? ev.payload.attachments : [];
        for (const a of atts) {
          if (a?.name && a?.contentType) lines.push(`<attachment name="${a.name}" mimeType="${a.contentType}" />`);
        }
      } else if (ev.type === "user_reply") {
        const text = String(ev.payload?.text || "");
        lines.push(`<message from="user" at="${ev.timestamp}">${text}</message>`);
      } else if (ev.type === "planner_ask_user") {
        const q = String(ev.payload?.text || "");
        lines.push(`<message from="planner" kind="ask_user" at="${ev.timestamp}">${q}</message>`);
      } else if (ev.type === "trace") {
        if (ev.payload?.type === "thought") lines.push(`<thought at="${ev.timestamp}">${ev.payload.content}</thought>`);
      } else if (ev.type === "tool_call") {
        const name = String(ev.payload?.name || '');
        const args = ev.payload?.args ?? {};
        const reasoning = typeof ev.payload?.reasoning === 'string' ? ev.payload.reasoning : '';
        const body = { reasoning, action: { tool: name, args } };
        lines.push(`<tool_call at="${ev.timestamp}">${JSON.stringify(body)}</tool_call>`);
      } else if (ev.type === "tool_result") {
        lines.push(`<tool_result at="${ev.timestamp}">${JSON.stringify(ev.payload?.result ?? {})}</tool_result>`);
      }
    }
    return lines.join("\n");
  }

  private buildAvailableFilesXml(): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    try {
      const vaultFiles = (this.deps.vault as any).listForPlanner?.() || [];
      for (const f of vaultFiles) {
        const name = String((f as any)?.name || "");
        if (!name) continue;
        seen.add(name);
        const mimeType = String((f as any)?.mimeType || "application/octet-stream");
        const size = Number((f as any)?.size || 0);
        const isPrivate = (f as any)?.private ? "true" : "false";
        lines.push(`<file name="${name}" mimeType="${mimeType}" size="${size}" source="vault" private="${isPrivate}" />`);
      }
    } catch {}
    try {
      for (const doc of this.documents.values()) {
        const name = String(doc?.name || "");
        if (!name || seen.has(name)) continue;
        const mimeType = String(doc?.contentType || "text/markdown");
        lines.push(`<file name="${name}" mimeType="${mimeType}" source="synth" />`);
      }
    } catch {}
    return lines.join("\n");
  }

  private buildPrompt(): string {
    const parts: string[] = [];
    const sc = this.scenario as any;
    const plannerId = this.deps.getPlannerAgentId?.() || this.myAgentId || undefined;
    if (sc && Array.isArray(sc.agents) && plannerId) {
      const me = (sc.agents as any[]).find(a => a?.agentId === plannerId);
      const others = (sc.agents as any[]).filter(a => a?.agentId !== plannerId);
      parts.push("<SCENARIO>");
      const md = sc.metadata || {};
      if (md.title || md.id) parts.push(`Title: ${md.title || md.id}`);
      if (md.description) parts.push(`Description: ${md.description}`);
      if (md.background) parts.push(`Background: ${md.background}`);
      if (me) {
        parts.push(`<YOUR_ROLE>`);
        parts.push(`You are agent \"${me.agentId}\" for ${me.principal?.name || "Unknown"}.`);
        if (me.principal?.description) parts.push(`Principal Info: ${me.principal.description}`);
        if (me.principal?.type) parts.push(`Principal Type: ${me.principal.type}`);
        if (me.systemPrompt) parts.push(`System: ${me.systemPrompt}`);
        if (me.situation) parts.push(`Situation: ${me.situation}`);
        if (Array.isArray(me.goals) && me.goals.length) parts.push("Goals:\n" + me.goals.map((g:any) => `- ${g}`).join("\n"));
        parts.push(`</YOUR_ROLE>`);
      }
      if (others.length) {
        parts.push("Counterparts:");
        for (const a of others) {
          const info: string[] = [];
          info.push(`${a.agentId} (for ${a.principal?.name || "Unknown"})`);
          if (a.principal?.description) info.push(`desc: ${a.principal.description}`);
          if (a.principal?.type) info.push(`type: ${a.principal.type}`);
          parts.push(`- ${info.join('; ')}`);
        }
      }
      parts.push("</SCENARIO>");
      parts.push("");
    } else if (plannerId) {
      // Minimal identity if scenario config is not available
      parts.push("<SCENARIO>");
      parts.push(`<YOUR_ROLE>`);
      parts.push(`You are agent \"${plannerId}\".`);
      const counterpart = this.deps.getCounterpartAgentId?.();
      if (counterpart) parts.push(`Counterpart: ${counterpart}`);
      parts.push(`</YOUR_ROLE>`);
      parts.push("</SCENARIO>");
      parts.push("");
    }

    const extra = this.deps.getAdditionalInstructions?.();
    if (extra && String(extra).trim()) {
      parts.push("<ADDITIONAL_INSTRUCTIONS>");
      parts.push(String(extra).trim());
      parts.push("</ADDITIONAL_INSTRUCTIONS>");
      parts.push("");
    }

    parts.push("<EVENT_LOG>");
    parts.push(this.buildXmlHistory() || "<!-- none -->");
    parts.push("</EVENT_LOG>");
    parts.push("");

    parts.push("<AVAILABLE_FILES>");
    parts.push(this.buildAvailableFilesXml() || "<!-- none -->");
    parts.push("</AVAILABLE_FILES>");
    parts.push("");

    const enabled = this.deps.getEnabledTools?.() || [];
    parts.push("<TOOLS>");
    parts.push("Respond with exactly ONE JSON object describing your reasoning and chosen action.");
    parts.push("Schema: { reasoning: string, action: { tool: string, args: object } }");
    parts.push("");
    parts.push("Always-available tools:");
    parts.push("// Send a message to the remote agent (counterpart). Attachments may be included by docId (preferred) or by name matching AVAILABLE_FILES.");
    parts.push("interface SendMessageToRemoteAgentArgs { text?: string; attachments?: Array<{ docId?: string; name?: string }>; finality?: 'none'|'turn'|'conversation'; }");
    parts.push("Tool: sendMessageToRemoteAgent: SendMessageToRemoteAgentArgs");
    parts.push("");
    parts.push("// Send a message to the local user. Attachments may be included (for presentation to the user).");
    parts.push("interface SendMessageToUserArgs { text: string; attachments?: Array<{ docId?: string; name?: string }>; }");
    parts.push("Tool: sendMessageToUser: SendMessageToUserArgs");
    parts.push("");
    parts.push("// Sleep until a new event arrives (no arguments).");
    parts.push("type SleepArgs = {};");
    parts.push("Tool: sleep: SleepArgs");
    parts.push("");
    parts.push("// Declare that you're fully done: you've completed the task with the remote agent and wrapped up with the user; nothing remains.");
    parts.push("interface DoneArgs { summary?: string }");
    parts.push("Tool: done: DoneArgs");
    if (enabled.length) {
      // Scenario-Specific Tools (enabled)
      const schemaToTs = (schema: any, indent = 0): string => {
        const pad = '  '.repeat(indent);
        if (!schema || typeof schema !== 'object') return 'any';
        const t = schema.type;
        if (t === 'string' || t === 'number' || t === 'boolean') return t;
        if (t === 'integer') return 'number';
        if (t === 'array') {
          const it = schema.items ? schemaToTs(schema.items, indent) : 'any';
          return `Array<${it}>`;
        }
        if (t === 'object' || schema.properties) {
          const req: string[] = Array.isArray(schema.required) ? schema.required : [];
          const props = schema.properties || {};
          const lines: string[] = ['{'];
          for (const k of Object.keys(props)) {
            const opt = req.includes(k) ? '' : '?';
            const doc = props[k]?.description ? ` // ${String(props[k].description)}` : '';
            lines.push(`${pad}  ${k}${opt}: ${schemaToTs(props[k], indent + 1)};${doc}`);
          }
          lines.push(pad + '}');
          return lines.join('\n');
        }
        return 'any';
      };
      parts.push("");
      parts.push("Scenario-Specific Tools (enabled):");
      try {
        const sc: any = this.scenario;
        const plannerId = this.deps.getPlannerAgentId?.() || this.myAgentId || '';
        const agentDef = Array.isArray(sc?.agents) ? sc.agents.find((a: any) => a?.agentId === plannerId) : null;
        const toolDefs: any[] = Array.isArray(agentDef?.tools) ? agentDef.tools : [];
        for (const t of enabled) {
          const def = toolDefs.find((d: any) => (d?.toolName || d?.name) === t.name) || {};
          const name = String(t.name);
          const desc = String(t.description || def?.description || '');
          parts.push(`// ${desc}`.trim());
          if ((def as any).inputSchema) {
            const iface = schemaToTs((def as any).inputSchema);
            parts.push(`interface ${name}Args ${iface}`);
            parts.push(`Tool: ${name}: ${name}Args`);
          } else {
            parts.push(`interface ${name}Args { /* see description */ }`);
            parts.push(`Tool: ${name}: ${name}Args`);
          }
          parts.push('');
        }
      } catch {}
    }
    parts.push("");
    parts.push("</TOOLS>");

    parts.push("");
    parts.push("<RESPONSE>");
    parts.push("Output exactly one JSON object with fields 'reasoning' and 'action'. No extra commentary or code fences.");
    parts.push("</RESPONSE>");
    return parts.join("\n");
  }

  private async callLLM(prompt: string): Promise<{ content: string }> {
    // Do not constrain max tokens; let server/provider defaults apply
    const body: any = {
      messages: [
        { role: "system", content: "You are a turn-based agent planner. Respond with JSON only." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
    };
    const url = `${this.deps.getApiBase()}/llm/complete`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const j = await res.json();
    const text = String(j?.content ?? "");
    return { content: text };
  }

  private parseAction(text: string): { reasoning: string; tool: string; args: any } {
    let raw = String(text || "").trim();
    // tolerate code fences: ```json ...``` or ``` ...```
    let m = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
    if (m && m[1]) raw = m[1].trim();
    const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
    const objTxt = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
    try {
      const obj: any = JSON.parse(objTxt);
      if (obj && typeof obj === 'object') {
        if (obj.action && typeof obj.action === 'object') {
          return { reasoning: String(obj.reasoning || ""), tool: String(obj.action.tool || "sleep"), args: obj.action.args || {} };
        }
        if (obj.toolCall && typeof obj.toolCall === 'object') {
          return { reasoning: String(obj.reasoning || obj.thought || ""), tool: String(obj.toolCall.tool || "sleep"), args: obj.toolCall.args || {} };
        }
      }
      return { reasoning: String(obj?.reasoning || obj?.thought || ""), tool: "sleep", args: { ms: 200 } };
    } catch {
      return { reasoning: "parse error", tool: "sleep", args: { ms: 200 } };
    }
  }

  private indexDocumentsFromResult(obj: any) {
    // recursively find any { docId, name, contentType, content?, summary? }
    const walk = (x: any) => {
      if (!x || typeof x !== 'object') return;
      if (typeof x.docId === 'string') {
        const docId = x.docId;
        const name = String(x.name || docId);
        const contentType = String(x.contentType || 'text/markdown');
        const content = typeof x.content === 'string' ? x.content : undefined;
        const summary = typeof x.summary === 'string' ? x.summary : undefined;
        this.documents.set(docId, { docId, name, contentType, content, summary });
      }
      if (Array.isArray(x)) x.forEach(walk);
      else for (const k of Object.keys(x)) walk(x[k]);
    };
    try { walk(obj); } catch {}
  }

  private utf8ToBase64(s: string): string {
    try { return btoa(unescape(encodeURIComponent(s))); } catch { return btoa(s); }
  }

  private async tickOnce() {
    const prompt = this.buildPrompt();
    const { content } = await this.callLLM(prompt);
    const { reasoning, tool, args } = this.parseAction(content);

    if (tool === "sleep") {
      // No args; wait briefly and rely on event-driven wakeups
      await new Promise(r => setTimeout(r, 150));
      return;
    }

    if (tool === "sendMessageToUser" || tool === "askUser") {
      const q = String(args?.text || "").trim();
      if (q) this.deps.onAskUser(q);
      this.pushEvent({ type: "tool_call", agentId: this.deps.getPlannerAgentId() || this.myAgentId || "planner", payload: { name: "askUser", args, callId: `call_${Date.now()}`, reasoning } });
      return;
    }

    if (tool === "readAttachment") {
      const name = String(args?.name || "");
      const a = this.deps.vault.getByName(name);
      const ok = !!a && !a.private;
      const callId = `call_${Date.now()}`;
      const result = ok ? { ok: true, name: a!.name, mimeType: a!.mimeType, size: a!.size, text_excerpt: a!.summary || undefined } : { ok: false, reason: "not found or private" };
      this.turnScratch.toolCalls.push({ callId, name: "readAttachment", args, result });
      this.pushEvent({ type: "tool_call", agentId: this.deps.getPlannerAgentId() || this.myAgentId || "planner", payload: { name: "readAttachment", args, callId, reasoning } });
      this.pushEvent({ type: "tool_result", agentId: this.deps.getPlannerAgentId() || this.myAgentId || "planner", payload: { result, callId } });
      // Reconsider now that a result is available
      this.maybeTick();
      return;
    }

    if (tool === "done") {
      const summary = String(args?.summary || "");
      if (summary) this.deps.onSystem(`Planner done: ${summary}`);
      this.pushEvent({ type: "tool_call", agentId: this.deps.getPlannerAgentId() || this.myAgentId || "planner", payload: { name: "done", args, callId: `call_${Date.now()}`, reasoning } });
      return;
    }

    if (tool === "sendMessage" || tool === "sendMessageToRemoteAgent") {
      const text = String(args?.text || "");
      const fin = String(args?.finality || 'none');
      const finality = fin === 'conversation' ? 'conversation' : fin === 'turn' ? 'turn' : 'turn';
      const atts = Array.isArray(args?.attachments) ? args.attachments : [];
      const parts: any[] = [];
      if (text) parts.push({ kind: "text", text });
      for (const a of atts) {
        const hasDoc = a && (typeof a.docId === 'string');
        if (hasDoc) {
          const doc = this.documents.get(String(a.docId));
          if (doc) {
            const name = doc.name || String(a.name || 'attachment');
            const mimeType = doc.contentType || String(a.mimeType || 'text/markdown');
            const bytes = typeof doc.content === 'string' ? this.utf8ToBase64(doc.content) : undefined;
            if (bytes) parts.push({ kind: 'file', file: { name, mimeType, bytes } });
            continue;
          }
        }
        // Fallback by name via vault
        if (a?.name) {
          const rec = this.deps.vault.getByName(String(a.name));
          if (rec) parts.push({ kind: "file", file: { name: rec.name, mimeType: rec.mimeType, bytes: rec.bytes } });
        }
      }
      const callId = `call_${Date.now()}`;
      this.pushEvent({ type: "tool_call", agentId: this.deps.getPlannerAgentId() || this.myAgentId || "planner", payload: { name: "sendMessage", args, callId, reasoning } });
      if (!this.deps.task.getTaskId()) await this.deps.task.startNew(parts as any);
      else await this.deps.task.send(parts as any);
      if (finality === "conversation") this.deps.onSystem("Planner requested conversation end");
      return;
    }
    // Handle dynamic synthesis tools by name via ToolSynthesisService
    const enabledDefs = (this.deps.getEnabledTools?.() || []);
    const enabledNames = enabledDefs.map(t => t.name);
    if (enabledNames.includes(tool)) {
      const callId = `call_${Date.now()}`;
      this.pushEvent({ type: "tool_call", agentId: this.deps.getPlannerAgentId() || this.myAgentId || "planner", payload: { name: tool, args, callId, reasoning } });
      try {
        if (!this.oracle) this.oracle = new ToolSynthesisService(new BrowserLLMProvider({ provider: 'browserside' }));
        const sc: any = this.scenario;
        const plannerId = this.deps.getPlannerAgentId?.() || this.myAgentId || '';
        const agentDef = Array.isArray(sc?.agents) ? sc.agents.find((a: any) => a?.agentId === plannerId) : null;
        const toolDef = enabledDefs.find(t => t.name === tool) as any;
        const conversationHistory = this.buildXmlHistory();
        const result = await this.oracle.execute({
          tool: {
            toolName: toolDef?.name || tool,
            description: toolDef?.description || '',
            synthesisGuidance: toolDef?.synthesisGuidance || 'Produce realistic output consistent with scenario.',
            inputSchema: toolDef?.inputSchema,
            endsConversation: toolDef?.endsConversation,
            conversationEndStatus: toolDef?.conversationEndStatus,
          },
          args: args || {},
          agent: {
            agentId: plannerId,
            principal: agentDef?.principal,
            situation: agentDef?.situation,
            systemPrompt: agentDef?.systemPrompt,
            goals: agentDef?.goals,
          },
          scenario: sc,
          conversationHistory,
        } as any);
        // Log tool_result and index any returned documents
        this.turnScratch.toolCalls.push({ callId, name: tool, args, result: result?.output });
        this.pushEvent({ type: "tool_result", agentId: this.deps.getPlannerAgentId() || this.myAgentId || "planner", payload: { result: result?.output, callId } });
        this.indexDocumentsFromResult(result?.output);
      } catch (e: any) {
        const err = { ok: false, error: String(e?.message ?? e) };
        this.turnScratch.toolCalls.push({ callId, name: tool, args, result: err });
        this.pushEvent({ type: "tool_result", agentId: this.deps.getPlannerAgentId() || this.myAgentId || "planner", payload: { result: err, callId } });
      }
      // Reconsider planning after any tool_result
      this.maybeTick();
      return;
    }
  }
}
