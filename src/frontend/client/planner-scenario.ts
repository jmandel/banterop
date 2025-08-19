// Scenario-aware planner (sketch) for A2A client
// Goal: Keep the same UI surface but replace the planning loop
// with a scenario-driven, event-log- and scratchpad-oriented loop.

import type { TaskClientLike } from "./protocols/task-client";
import { AttachmentVault } from "./attachments-vault";
import { ToolSynthesisService } from '$src/agents/services/tool-synthesis.service';
import { parseBridgeEndpoint } from './bridge-endpoint';
import { BrowsersideLLMProvider } from '$src/llm/providers/browserside';
import type { UnifiedEvent as StrictEvent, EventType, AttachmentLite } from './types/events';
import { makeEvent, assertEvent } from './types/events';

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

// Legacy event type kept only for replay during migration
export type LegacyEvent = {
  seq: number;
  timestamp: string;
  type: "agent_message" | "trace" | "planner_ask_user" | "user_reply" | "tool_call" | "tool_result" | "send_to_remote_agent" | "send_to_user" | "read_attachment";
  agentId: string;
  payload: any;
};

type IntraTurnState = {
  thoughts: string[];
  toolCalls: Array<{ callId: string; name: string; args: any; result?: any }>;
};

type ScenarioPlannerDeps = {
  // Task client may be temporarily null during resets
  task: TaskClientLike | null;
  vault: AttachmentVault;

  // Fetch API base used by server LLM proxy and scenario endpoints
  getApiBase: () => string; // e.g., http://localhost:3000/api

  // Endpoint URL for A2A; used to decode config64 to find scenario
  getEndpoint: () => string;
  // Selected agent identities (from UI)
  getPlannerAgentId: () => string | undefined;
  getCounterpartAgentId: () => string | undefined;
  getAdditionalInstructions?: () => string | undefined;
  // Explicit scenario config from UI (preferred)
  getScenarioConfig?: () => any;
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
  // UI hint: show "Thinking…" only during local LLM calls
  onPlannerThinking?: (busy: boolean) => void;
};

export class ScenarioPlannerV2 {
  private running = false;
  private busy = false;
  private pendingTick = false;
  private eventLog: StrictEvent[] = [];
  private turnScratch: IntraTurnState = { thoughts: [], toolCalls: [] };
  private scenario: ScenarioConfiguration | null = null;
  private myAgentId: string | null = null;
  private seq = 0;
  private listeners = new Set<(e: StrictEvent) => void>();
  private documents = new Map<string, { name: string; contentType: string; content?: string; summary?: string }>();
  private oracle: ToolSynthesisService | null = null;
  private llmProvider: BrowsersideLLMProvider | null = null;
  private taskOff: (() => void) | null = null;

  constructor(private deps: ScenarioPlannerDeps) {}

  // Preload a prior event log (e.g., from persistence) before start()
  loadEvents(events: any[]) {
    try {
      // Accept strict events only; legacy events are ignored for the unified log but used to rebuild vault
      const stricts: StrictEvent[] = Array.isArray(events)
        ? (events as any[]).filter(e => e && typeof e === 'object' && typeof (e as any).channel === 'string')
        : [];
      this.eventLog = [...stricts];
      // Set sequence to the max existing seq to avoid collisions
      const maxSeq = this.eventLog.reduce((m, e) => Math.max(m, Number(e?.seq || 0)), 0);
      this.seq = Number.isFinite(maxSeq) ? maxSeq : this.seq;
      // Rebuild vault/doc index deterministically by replaying events in order
      for (const ev of this.eventLog) {
        if (ev.type === 'tool_result') {
          try { this.indexDocumentsFromResult((ev as any)?.payload?.result); } catch {}
        }
        if (ev.type === 'message' && ev.channel === 'planner-agent' && ev.author === 'agent') {
          const atts = Array.isArray((ev as any)?.payload?.attachments) ? (ev as any).payload.attachments : [];
          for (const a of atts) {
            try {
              const name = String(a?.name || '');
              const mime = String(a?.mimeType || 'application/octet-stream');
              const bytes = typeof a?.bytes === 'string' ? a.bytes : '';
              if (name) this.deps.vault.addFromAgent(name, mime, bytes);
            } catch {}
          }
        }
      }
      // Also consider legacy events for vault rebuild in case older sessions are loaded
      const legacy: LegacyEvent[] = Array.isArray(events)
        ? (events as any[]).filter(e => e && typeof e === 'object' && typeof (e as any).agentId === 'string' && !(e as any).channel)
        : [];
      for (const ev of legacy) {
        if (ev.type === 'tool_result') {
          try { this.indexDocumentsFromResult((ev as any)?.payload?.result); } catch {}
        }
        if (ev.type === 'agent_message') {
          const atts = Array.isArray((ev as any)?.payload?.attachments) ? (ev as any).payload.attachments : [];
          for (const a of atts) {
            try {
              const name = String(a?.name || '');
              const mime = String(a?.mimeType || (a as any).contentType || 'application/octet-stream');
              const bytes = typeof a?.bytes === 'string' ? a.bytes : '';
              if (name) this.deps.vault.addFromAgent(name, mime, bytes);
            } catch {}
          }
        }
      }
    } catch {}
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.subscribeTask();
    void this.ensureScenarioLoaded();
    // Try an initial tick right away (will be gated by canActNow)
    this.maybeTick();
  }

  stop() {
    this.running = false;
    try { this.taskOff?.(); } catch {}
    this.taskOff = null;
    // Reset transient tick state so a restarted planner begins cleanly
    this.busy = false;
    this.pendingTick = false;
  }

  // Strict helper: create+validate+push
  private emit<T extends EventType>(partial: Omit<StrictEvent & { type: T }, 'seq' | 'timestamp'>): StrictEvent {
    const ev = makeEvent(++this.seq, partial as any);
    assertEvent(ev);
    this.eventLog.push(ev);
    // Side-effect: index tool docs
    if (ev.type === 'tool_result') {
      try { this.indexDocumentsFromResult((ev as any).payload?.result); } catch {}
    }
    for (const cb of this.listeners) cb(ev);
    return ev;
  }

  recordUserReply(text: string) {
    if (!text?.trim()) return;
    this.emit({ type: 'message', channel: 'user-planner', author: 'user', payload: { text: String(text).trim() } } as any);
    this.maybeTick();
  }

  onEvent(cb: (e: StrictEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getEvents(): StrictEvent[] { return [...this.eventLog]; }

  // Seeding removed: rely on persisted plannerEvents only

  private subscribeTask() {
    // Ensure prior subscription (if any) is removed before attaching a new one
    try { this.taskOff?.(); } catch {}
    this.taskOff = null;
    const task = this.deps.task as any;
    if (!task || typeof task.on !== 'function') {
      try { console.warn('[Planner] subscribeTask skipped: no task bound'); } catch {}
      return;
    }
    this.taskOff = task.on("new-task", () => {
      const t = task.getTask?.();
      // Emit status event if changed (from remote)
      try {
        const st = String(t?.status?.state || '');
        if (st) {
          const lastSt = [...this.eventLog].reverse().find(e => e.type === 'status') as any;
          const prev = String(lastSt?.payload?.state || '');
          if (st !== prev) this.emit({ type: 'status', channel: 'status', author: 'system', payload: { state: st as any } } as any);
        }
      } catch {}
      const last = (t?.history || []).slice(-1)[0];
      if (!last) return;
      if (String(last.role) === 'user') return; // avoid duplicating planner sends
      const text = (last.parts || []).filter((p: any) => p?.kind === "text").map((p: any) => p.text).join("\n") || '';
      const attachments: AttachmentLite[] = (last.parts || [])
        .filter((p: any) => p?.kind === 'file' && p?.file)
        .map((p: any) => ({ name: p.file.name, mimeType: p.file.mimeType, bytes: p.file.bytes, uri: p.file.uri }))
        .filter((a: any) => a?.name && a?.mimeType);
      // Upsert into vault first
      for (const a of attachments) {
        try { this.deps.vault.addFromAgent(a.name, a.mimeType, a.bytes || ''); } catch {}
      }
      if (text || attachments.length) {
        this.emit({ type: 'message', channel: 'planner-agent', author: 'agent', payload: { text, attachments: attachments.length ? attachments : undefined } } as any);
      }
      this.maybeTick();
    });
  }

  // Deprecated: do not auto-extract scenario from endpoint config64; only provide apiBase
  private decodeConfig64FromEndpoint(): { scenarioId?: string; startingAgentId?: string; apiBase: string } | null {
    try {
      const url = this.deps.getEndpoint();
      const parsed = parseBridgeEndpoint(url);
      const api = (parsed?.apiBase) || this.deps.getApiBase();
      return { apiBase: api };
    } catch {
      return { apiBase: this.deps.getApiBase() };
    }
  }

  private async ensureScenarioLoaded() {
    try {
      // Prefer explicit scenario config from UI state if provided
      const cfg = this.deps.getScenarioConfig?.();
      if (cfg && typeof cfg === 'object') this.scenario = cfg;
      // Capture preferred starting agent if defined in config
      const explicit = this.deps.getPlannerAgentId?.();
      const starting = (cfg?.metadata?.startingAgentId) || undefined;
      this.myAgentId = explicit || starting || this.myAgentId;
    } catch {}
    this.maybeTick();
  }

  private canActNow(): boolean {
    // Derive from Event Log: if no status yet → allow initial; else allow when input-required or completed
    const last = [...this.eventLog].reverse().find(e => e.type === 'status') as any;
    if (!last) return true;
    const st = String(last?.payload?.state || '');
    return st === 'input-required' || st === 'completed';
  }

  private maybeTick() {
    const canAct = this.canActNow();
    // Do not delay on external scenario; rely on explicit UI-provided config
    const decision = !this.running
      ? 'skip:not_running'
      : this.busy
        ? 'skip:busy'
        : !canAct
          ? 'skip:cant_act'
          : 'proceed';
    try {
      // Log full events object for expandable console inspection
      console.log('[PlannerTick] consider', { events: this.eventLog, running: this.running, busy: this.busy, status: this.deps.task?.getStatus?.(), hasTask: !!this.deps.task?.getTaskId?.() }, 'decision', decision);
    } catch {}
    if (!this.running) return;
    if (this.busy) { this.pendingTick = true; return; }
    if (!canAct) return;
    this.busy = true;
    (async () => {
      try {
        await this.tickOnce();
      } catch (e: any) {
        try {
          const msg = String(e?.message || e || 'Planner error');
          const stack = String(e?.stack || '');
          console.error('[PlannerTick] error:', e);
          // Record an internal trace event (strict)
          this.emit({ type: 'trace', channel: 'system', author: 'system', payload: { text: `Planner error: ${msg}` } } as any);
        } catch {}
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
      if (ev.type === 'message') {
        const rawText = String((ev as any).payload?.text || '');
        const safeText = rawText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const atts = Array.isArray((ev as any).payload?.attachments) ? (ev as any).payload.attachments : [];
        if (ev.channel === 'user-planner') {
          const from = ev.author === 'user' ? 'user' : 'planner';
          lines.push(`<message from="${from}">`);
          if (safeText) lines.push(safeText);
          for (const a of atts) {
            const name = String(a?.name || 'attachment');
            const mime = String(a?.mimeType || 'application/octet-stream');
            lines.push(`<attachment name="${name}" mimeType="${mime}" />`);
          }
          lines.push(`</message>`);
        } else if (ev.channel === 'planner-agent') {
          const from = ev.author === 'planner' ? 'planner' : 'agent';
          lines.push(`<message from="${from}">`);
          if (safeText) lines.push(safeText);
          for (const a of atts) {
            const name = String(a?.name || 'attachment');
            const mime = String(a?.mimeType || 'application/octet-stream');
            lines.push(`<attachment name="${name}" mimeType="${mime}" />`);
          }
          lines.push(`</message>`);
        }
      } else if (ev.type === 'tool_call') {
        const name = String((ev as any).payload?.name || '');
        const args = (ev as any).payload?.args ?? {};
        const body = { action: { tool: name, args } };
        lines.push(`<tool_call>${JSON.stringify(body)}</tool_call>`);
      } else if (ev.type === 'tool_result') {
        const res = (ev as any).payload?.result;
        // Render synthesized texts if available
        let rendered = false;
        try {
          const docs: any[] = Array.isArray(res?.documents) ? res.documents : [];
          const single = (res && typeof res === 'object' && (res.name || res.docId)) ? [res] : [];
          const all = (docs.length ? docs : single) as any[];
          for (const d of all) {
            const name = String(d?.name || d?.docId || 'result');
            const body = typeof d?.content === 'string' ? d.content : (typeof d?.text === 'string' ? d.text : undefined);
            if (name && typeof body === 'string' && body) {
              const safe = body.replace(/</g, '&lt;').replace(/>/g, '&gt;');
              lines.push(`<tool_result filename="${name}">\n${safe}\n</tool_result>`);
              rendered = true;
            }
          }
        } catch {}
        if (!rendered) lines.push(`<tool_result>${JSON.stringify(res ?? {})}</tool_result>`);
      } else if (ev.type === 'read_attachment') {
        const name = String((ev as any).payload?.name || '').trim();
        if (!name) continue;
        // synthesize a call + result
        const callBody = { action: { tool: 'readAttachment', args: { name } } };
        lines.push(`<tool_call>${JSON.stringify(callBody)}</tool_call>`);
        let content: string | undefined;
        const doc = this.documents.get(name);
        if (doc && typeof doc.content === 'string') content = doc.content;
        if (!content) {
          const rec = (this.deps.vault as any).getByName?.(name);
          if (rec && typeof rec.bytes === 'string') {
            const bin = atob(rec.bytes);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            content = new TextDecoder('utf-8').decode(bytes);
          }
        }
        if (typeof content === 'string' && content.trim()) {
          const safe = content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          lines.push(`<tool_result filename="${name}">\n${safe}\n</tool_result>`);
        } else {
          lines.push(`<tool_result filename="${name}">"(unavailable)"</tool_result>`);
        }
      }
    }
    // Do not inject suggested starting message into event log XML; it will be
    // surfaced separately in the prompt just before <RESPONSE>.
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

    // General guidance for user-facing updates
    parts.push("<GENERAL_GUIDANCE>");
    parts.push("Proactively report important progress, outcomes, or blockers to the user using sendMessageToUser.");
    parts.push("Examples: milestone reached, decision made, error encountered, delay expected, or conversation completed.");
    parts.push("Keep updates concise, actionable, and free of internal jargon.");
    parts.push("</GENERAL_GUIDANCE>");
    parts.push("");

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
    parts.push("// Send a message to the remote agent (counterpart). Attachments should be included by 'name' (matching AVAILABLE_FILES).");
    parts.push("interface SendMessageToRemoteAgentArgs { text?: string; attachments?: Array<{ name: string }>; finality?: 'none'|'turn'|'conversation'; }");
    parts.push("Tool: sendMessageToRemoteAgent: SendMessageToRemoteAgentArgs");
    parts.push("");
    parts.push("// Send a message to the local user. Attachments may be included by 'name' if desired.");
    parts.push("interface SendMessageToUserArgs { text: string; attachments?: Array<{ name: string }>; }");
    parts.push("Tool: sendMessageToUser: SendMessageToUserArgs");
    parts.push("");
    parts.push("// Sleep until a new event arrives (no arguments).");
    parts.push("type SleepArgs = {};");
    parts.push("Tool: sleep: SleepArgs");
    parts.push("");
    parts.push("// Read a previously uploaded attachment by name (from AVAILABLE_FILES).");
    parts.push("interface ReadAttachmentArgs { name: string }");
    parts.push("Tool: readAttachment: ReadAttachmentArgs");
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
    // If there's a suggested initiating message for the planner and we
    // haven't yet sent a message to the remote agent, surface it here
    // outside of the event log, just before <RESPONSE>.
    try {
      const hasPlannerContact = this.eventLog.some(ev =>
        (ev.type === 'message' && ev.channel === 'planner-agent' && ev.author === 'planner')
      );
      if (!hasPlannerContact) {
        const sc: any = this.scenario;
        const plannerId = this.deps.getPlannerAgentId?.() || this.myAgentId || '';
        const me = Array.isArray(sc?.agents) ? sc.agents.find((a: any) => a?.agentId === plannerId) : null;
        const suggested: string | undefined = me?.messageToUseWhenInitiatingConversation || me?.initialMessage || undefined;
        if (suggested && String(suggested).trim()) {
          parts.push('<suggested_starting_message>');
          parts.push(String(suggested).trim());
          parts.push('</suggested_starting_message>');
          parts.push('');
        }
      }
    } catch {}
    parts.push("<RESPONSE>");
    parts.push("Output exactly one JSON object with fields 'reasoning' and 'action'. No extra commentary or code fences.");
    parts.push("</RESPONSE>");
    return parts.join("\n");
  }

  private async callLLM(prompt: string): Promise<{ content: string }> {
    // Route completions through the shared Browserside provider with simple retries
    const api = this.deps.getApiBase();
    const serverUrl = api.replace(/\/api$/, '');
    if (!this.llmProvider) {
      this.llmProvider = new BrowsersideLLMProvider({ provider: 'browserside', serverUrl });
    }
    const maxAttempts = 3;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await this.llmProvider.complete({
          messages: [
            { role: 'system', content: 'You are a turn-based agent planner. Respond with JSON only.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          loggingMetadata: {},
        } as any);
        return { content: String(resp?.content ?? '') };
      } catch (e: any) {
        lastErr = e;
        if (attempt < maxAttempts) {
          // Exponential backoff with a little jitter
          const base = 200;
          const delay = base * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 50);
          try { await new Promise(res => setTimeout(res, delay)); } catch {}
          continue;
        }
      }
    }
    throw lastErr ?? new Error('LLM call failed');
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

  private indexDocumentsFromResult(obj: any, opts?: { toolName?: string }): string[] {
    // recursively find any { docId, name, contentType, content?, summary? }
    let found = 0;
    const created: string[] = [];
    const walk = (x: any) => {
      if (!x || typeof x !== 'object') return;
      if (typeof x.docId === 'string') {
        const docId = x.docId;
        const name = String(x.name || docId);
        let contentType: string = String(x.contentType || '');
        let contentStr: string | undefined;
        // Prefer explicit content; if it's an object, stringify
        if (typeof x.content === 'string') {
          contentStr = x.content;
          if (!contentType) contentType = 'text/markdown';
        } else if (x.content && typeof x.content === 'object') {
          try { contentStr = JSON.stringify(x.content, null, 2); } catch { contentStr = String(x.content); }
          contentType = 'application/json';
        } else if (typeof x.text === 'string') {
          contentStr = x.text;
          if (!contentType) contentType = 'text/markdown';
        }
        if (!contentType) contentType = 'text/markdown';
        const summary = typeof x.summary === 'string' ? x.summary : undefined;
        // Track by filename only (no internal docId)
        this.documents.set(name, { name, contentType, content: contentStr, summary });
        try {
          if (typeof contentStr === 'string') {
            // Textual content: store human-readable version in vault under display name
            this.deps.vault.addSynthetic(name, contentType, contentStr);
          } else {
            // No content provided (e.g., PDFs). Ensure a placeholder exists so docId can be referenced.
            const existing = this.deps.vault.getByName(name);
            if (!existing) this.deps.vault.addFromAgent(name, contentType, '');
          }
        } catch {}
        found++;
        created.push(name);
      }
      if (Array.isArray(x)) x.forEach(walk);
      else for (const k of Object.keys(x)) walk(x[k]);
    };
    try { walk(obj); } catch {}
    if (!found && obj && typeof obj === 'object') {
      // Skip creating a synthetic file for tool results that explicitly indicate failure
      const status = String((obj as any)?.status || '').toLowerCase();
      const isError = (obj as any)?.ok === false || typeof (obj as any)?.error === 'string' || status === 'error' || status === 'failed';
      if (!isError) {
        const tool = opts?.toolName ? String(opts.toolName).replace(/[^a-z0-9]+/gi,'_').toLowerCase() : 'result';
        const name = `synth_${tool}_${Date.now()}.json`;
        const contentType = 'application/json';
        const contentUtf8 = JSON.stringify(obj, null, 2);
        this.documents.set(name, { name, contentType, content: contentUtf8, summary: undefined });
        try { this.deps.vault.addSynthetic(name, contentType, contentUtf8); } catch {}
        created.push(name);
      }
    }
    return created;
  }

  private utf8ToBase64(s: string): string {
    try { return btoa(unescape(encodeURIComponent(s))); } catch { return btoa(s); }
  }

  private async tickOnce() {
    // Signal local LLM thinking window
    let thinking = false;
    const setThinking = (b: boolean) => {
      if (thinking === b) return;
      thinking = b;
      try { this.deps.onPlannerThinking?.(b); } catch {}
    };
    const prompt = this.buildPrompt();
    let content: string = '';
    try {
      setThinking(true);
      const res = await this.callLLM(prompt);
      content = res.content;
    } finally {
      setThinking(false);
    }
    const { reasoning, tool, args } = this.parseAction(content);
    const lastSt = [...this.eventLog].reverse().find(e => e.type === 'status') as any;
    const statusNow = String(lastSt?.payload?.state || '');
    const canSendRemote = !lastSt || statusNow === 'input-required';

    if (tool === "sleep") {
      // No args; wait briefly and rely on event-driven wakeups
      await new Promise(r => setTimeout(r, 150));
      return;
    }

    if (tool === "sendMessageToUser" || tool === "askUser") {
      const q = String(args?.text || args?.question || "").trim();
      if (q) {
        this.emit({ type: 'message', channel: 'user-planner', author: 'planner', payload: { text: q } } as any);
        try { this.deps.onAskUser(q); } catch {}
      }
      return;
    }

    if (tool === "readAttachment") {
      const name = String(args?.name || "").trim();
      const a = name ? this.deps.vault.getByName(name) : undefined;
      const ok = !!a && !a.private;
      const payload = ok
        ? { name, ok: true, size: a!.size, truncated: !!a!.summary, text_excerpt: a!.summary || undefined }
        : { name, ok: false };
      this.emit({ type: 'read_attachment', channel: 'tool', author: 'planner', payload } as any);
      this.maybeTick();
      return;
    }

    if (tool === "done") {
      const summary = String(args?.summary || "").trim();
      if (summary) {
        try { this.deps.onSystem(`Planner done: ${summary}`); } catch {}
        // Also surface as trace in the log
        this.emit({ type: 'trace', channel: 'system', author: 'system', payload: { text: `Planner done: ${summary}` } } as any);
      }
      return;
    }

    if (tool === "sendMessage" || tool === "sendMessageToRemoteAgent") {
      if (!canSendRemote) {
        const err = { ok: false, error: 'Conversation is not accepting remote messages (completed or not your turn). You may send a final message to the user instead.' } as any;
        this.emit({ type: 'tool_result', channel: 'tool', author: 'planner', payload: { result: err } } as any);
        return;
      }
      const text = String(args?.text || "");
      const fin = String(args?.finality || 'none');
      const finality = fin === 'conversation' ? 'conversation' : fin === 'turn' ? 'turn' : 'turn';
      const atts = Array.isArray(args?.attachments) ? args.attachments : [];
      const parts: any[] = [];
      if (text) parts.push({ kind: "text", text });
      const unresolved: string[] = [];
      for (const a of atts) {
        if (a?.name) {
          const rec = this.deps.vault.getByName(String(a.name));
          if (rec) { parts.push({ kind: 'file', file: { name: rec.name, mimeType: rec.mimeType, bytes: rec.bytes } }); continue; }
          unresolved.push(String(a.name));
        }
      }
      if (unresolved.length) {
        const err = { ok: false, error: `Unknown attachment name(s): ${unresolved.join(', ')}` } as any;
        this.emit({ type: 'tool_result', channel: 'tool', author: 'planner', payload: { result: err } } as any);
        return;
      }
      // Emit unified message event to planner-agent channel (author planner)
      this.emit({ type: 'message', channel: 'planner-agent', author: 'planner', payload: { text, attachments: atts && atts.length ? atts.map((a: any)=>({ name: String(a.name), mimeType: String(a.mimeType || 'application/octet-stream') })) : undefined } } as any);
      if (this.deps.task) {
        if (!this.deps.task.getTaskId?.()) await (this.deps.task as any).startNew?.(parts as any);
        else await (this.deps.task as any).send?.(parts as any);
      }
      if (finality === "conversation") this.deps.onSystem("Planner requested conversation end");
      return;
    }
    // Handle dynamic synthesis tools by name via ToolSynthesisService
    const enabledDefs = (this.deps.getEnabledTools?.() || []);
    const enabledNames = enabledDefs.map(t => t.name);
    if (enabledNames.includes(tool)) {
      const callId = `call_${Date.now()}`;
      this.emit({ type: 'tool_call', channel: 'tool', author: 'planner', payload: { name: tool, args } } as any);
      try {
        setThinking(true);
        if (!this.oracle) {
          const api = this.deps.getApiBase();
          const serverUrl = api.replace(/\/api$/, '');
          const provider = new BrowsersideLLMProvider({ provider: 'browserside', serverUrl });
          this.oracle = new ToolSynthesisService(provider);
        }
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
        const filenames = this.indexDocumentsFromResult(result?.output, { toolName: tool });
        this.turnScratch.toolCalls.push({ callId, name: tool, args, result: result?.output });
        this.emit({ type: 'tool_result', channel: 'tool', author: 'planner', payload: { result: result?.output } } as any);
      } catch (e: any) {
        const err = { ok: false, error: String(e?.message ?? e) };
        this.turnScratch.toolCalls.push({ callId, name: tool, args, result: err });
        this.emit({ type: 'tool_result', channel: 'tool', author: 'planner', payload: { result: err } } as any);
      } finally { setThinking(false); }
      // Reconsider planning after any tool_result
      this.maybeTick();
      return;
    }
  }
}
