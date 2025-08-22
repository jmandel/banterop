// src/frontend/client/planner-scenario.ts
// Scenario-aware planner for Task Client (MCP or A2A)
// This version:
//  - Holds tools during 'working' (no nudges), allows exactly one user wrap-up after 'completed'
//  - Keeps remote-agent messaging allowed only when status === 'input-required'
//  - Supports terminal tools: after a terminal tool, planner auto-preps final message with 'conversation' finality

import type { TaskClientLike } from "./protocols/task-client";
import { AttachmentVault } from "./attachments-vault";
import { ToolSynthesisService } from '$src/agents/services/tool-synthesis.service';
import type { LLMProvider } from '$src/types/llm.types';
import type { UnifiedEvent as StrictEvent, EventType, AttachmentLite } from './types/events';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import { makeEvent, assertEvent } from './types/events';

type IntraTurnState = {
  thoughts: string[];
  toolCalls: Array<{ callId: string; name: string; args: any; result?: any }>;
};

type ScenarioPlannerDeps = {
  task: TaskClientLike | null;
  vault: AttachmentVault;

  getModel?: () => string | undefined;
  getLLMProvider: () => LLMProvider;

  getPlannerAgentId: () => string | undefined;
  getCounterpartAgentId: () => string | undefined;
  getAdditionalInstructions?: () => string | undefined;
  getScenarioConfig: () => ScenarioConfiguration | null;

  getToolRestrictions?: () => {
    omitCoreTools?: string[];
    omitScenarioTools?: string[];
  };

  onDebugPrompt?: (prompt: string) => void;
};

// Terminal tool tracking for auto-finalization
type TerminalState = {
  pending: boolean;
  status: 'success' | 'failure' | 'neutral';
  attachments: string[]; // names in vault
  note?: string;
};

export class ScenarioPlanner {
  private running = false;
  private busy = false;
  private pendingTick = false;
  private finished = false; // set true when fully done
  private eventLog: StrictEvent[] = [];
  private turnScratch: IntraTurnState = { thoughts: [], toolCalls: [] };
  private scenario: ScenarioConfiguration | null = null;
  private myAgentId: string | null = null;
  private seq = 0;
  private listeners = new Set<(e: StrictEvent) => void>();
  private documents = new Map<string, { name: string; contentType: string; content?: string; summary?: string }>();
  private oracle: ToolSynthesisService | null = null;
  private llmProvider: LLMProvider | null = null;
  private taskOff: (() => void) | null = null;

  // Terminal tool state
  private terminal: TerminalState = { pending: false, status: 'neutral', attachments: [] };

  // Allow exactly one wrap-up tick after 'completed'

  constructor(private deps: ScenarioPlannerDeps) {
    this.llmProvider = deps.getLLMProvider();
    this.scenario = deps.getScenarioConfig?.() || null;
    this.myAgentId = deps.getPlannerAgentId?.() || this.scenario?.agents[0]?.agentId || '';
  }

  // ---------- Public API ----------
  loadEvents(events: any[]) {
    try {
      const stricts: StrictEvent[] = Array.isArray(events)
        ? (events as any[]).filter(e => e && typeof e === 'object' && typeof (e as any).channel === 'string')
        : [];
      this.eventLog = [...stricts];
      const maxSeq = this.eventLog.reduce((m, e) => Math.max(m, Number(e?.seq || 0)), 0);
      this.seq = Number.isFinite(maxSeq) ? maxSeq : this.seq;

      // Replay: if prior log contains 'Planner done:' trace, mark done
      try {
        const hasDone = this.eventLog.some((e) => {
          if (e.type === 'trace' && e.channel === 'system' && e.author === 'system') {
            const payload = e.payload as { text?: string };
            return typeof payload.text === 'string' && payload.text.startsWith('Planner done:');
          }
          return false;
        });
        if (hasDone) this.finished = true;
      } catch {}

      // Re-index docs from tool results
      for (const ev of this.eventLog) {
        if (ev.type === 'tool_result') {
          try { this.indexDocumentsFromResult((ev as any)?.payload?.result); } catch {}
        }
        if (ev.type === 'message' && ev.channel === 'planner-agent' && ev.author === 'agent') {
          const atts = Array.isArray((ev as any)?.payload?.attachments) ? (ev as any).payload.attachments : [];
          for (const a of atts) {
            try {
              const name = String(a?.name || '');
              const mime = String(a?.mimeType || 'text/plain');
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
    this.maybeTick();
  }

  stop() {
    this.running = false;
    try { this.taskOff?.(); } catch {}
    this.taskOff = null;
    this.busy = false;
    this.pendingTick = false;
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

  emitMessageFromTask(last: any) {
    const text = (last.parts || []).filter((p: any) => p?.kind === 'text').map((p: any) => p.text).join('\n') || '';
    const attachments: AttachmentLite[] = (last.parts || [])
      .filter((p: any) => p?.kind === 'file' && p?.file)
      .map((p: any) => ({ name: p.file.name, mimeType: p.file.mimeType, bytes: p.file.bytes, uri: p.file.uri }))
      .filter((a: any) => a?.name && a?.mimeType);

    // upsert into vault
    for (const a of attachments) {
      try { this.deps.vault.addFromAgent(a.name, a.mimeType, a.bytes || ''); } catch {}
    }

    if (text || attachments.length) {
      this.emit({ type: 'message', channel: 'planner-agent', author: 'agent', payload: { text, attachments: attachments.length ? attachments : undefined } } as any);
    }
  }

  emitStatusChange(status: string) {
    this.emit({ type: 'status', channel: 'status', author: 'system', payload: { state: status as any } } as any);
  }

  // ---------- Internals ----------

  private subscribeTask() {
    try { this.taskOff?.(); } catch {}
    this.taskOff = null;
    const task = this.deps.task as any;
    if (!task || typeof task.on !== 'function') return;

    this.taskOff = task.on("new-task", () => {
      const t = task.getTask?.();
      let pendingStatus: string | undefined;

      try {
        const st = String(t?.status?.state || '');
        const lastSt = [...this.eventLog].reverse().find(e => e.type === 'status') as any;
        const prev = String(lastSt?.payload?.state || '');
        if (st && st !== prev) pendingStatus = st;
      } catch {}

      const last = (t?.history || []).slice(-1)[0];
      let emitted = false;
      if (last && String(last.role) !== 'user') {
        const text = (last.parts || []).filter((p: any) => p?.kind === 'text').map((p: any) => p.text).join('\n') || '';
        const attachments: AttachmentLite[] = (last.parts || [])
          .filter((p: any) => p?.kind === 'file' && p?.file)
          .map((p: any) => ({ name: p.file.name, mimeType: p.file.mimeType, bytes: p.file.bytes, uri: p.file.uri }))
          .filter((a: any) => a?.name && a?.mimeType);

        for (const a of attachments) {
          try { this.deps.vault.addFromAgent(a.name, a.mimeType, a.bytes || ''); } catch {}
        }
        if (text || attachments.length) {
          this.emit({ type: 'message', channel: 'planner-agent', author: 'agent', payload: { text, attachments: attachments.length ? attachments : undefined } } as any);
          emitted = true;
        }
      }

      if (pendingStatus) {
        try { this.emit({ type: 'status', channel: 'status', author: 'system', payload: { state: pendingStatus as any } } as any); } catch {}
      }

      if (emitted) this.maybeTick();
    });
  }

  private async ensureScenarioLoaded() {
    try {
      const cfg = this.deps.getScenarioConfig?.();
      if (cfg && typeof cfg === 'object') this.scenario = cfg;
      const explicit = this.deps.getPlannerAgentId?.();
      this.myAgentId = explicit || this.myAgentId;
    } catch {}
    this.maybeTick();
  }

  // Returns true if there's a user → planner message that has not yet
  // been followed by a planner → user message.
  private hasUnansweredUserMessage(): boolean {
    // Find the last user message directed at the planner
    let lastUserMsgSeq: number | null = null;
    for (let i = this.eventLog.length - 1; i >= 0; i--) {
      const e = this.eventLog[i] as any;
      if (e.type === 'message' && e.channel === 'user-planner' && e.author === 'user') {
        lastUserMsgSeq = e.seq;
        break;
      }
    }
    if (lastUserMsgSeq == null) return false;

    // Check if we (planner) have replied to user after that
    for (let i = this.eventLog.length - 1; i >= 0; i--) {
      const e = this.eventLog[i] as any;
      if (e.seq <= lastUserMsgSeq) break;
      if (e.type === 'message' && e.channel === 'user-planner' && e.author === 'planner') {
        return false; // answered
      }
    }
    return true; // no planner reply after the last user question
  }

  private canActNow(): boolean {
    // 1) First-run bootstrap
    if (this.eventLog.length === 0) return true;

    // 2) Hard stop only when truly finished (done / conversation closed)
    if (this.finished) return false;

    // 3) If the user asked something we haven't answered yet → act
    if (this.hasUnansweredUserMessage()) {
      console.log("We have unanswered user questions")
      return true;
    }
    // console.log('we do not have unanswre use mesagse', this.hasUnansweredUserMessage(), this.eventLog)

    const last = this.eventLog[this.eventLog.length - 1] as any;

    // 4) Immediate follow-ups after planner-local actions (tool progress)
    if (last && last.author === 'planner' &&
        (last.type === 'tool_call' || last.type === 'tool_result' || last.type === 'read_attachment')) {
      return true;
    }

    // 5) Status-aware gating for remote-agent workflow
    const lastStatus = [...this.eventLog].reverse().find(e => e.type === 'status') as any;
    const st = String(lastStatus?.payload?.state || '');

    // It's our turn to talk to the remote agent
    if (st === 'input-required') return true;

    return false;
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
      console.log('[PlannerTick] consider',
        { events: this.eventLog.length, running: this.running, busy: this.busy,
          status: (this.eventLog.slice().reverse().find(e => e.type==='status') as any)?.payload?.state,
          hasTask: !!this.deps.task?.getTaskId?.() },
        'decision', decision);
      // console.log("Basedon last ev", this.eventLog.slice(-1)[0]);
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
          this.emit({ type: 'trace', channel: 'system', author: 'system', payload: { text: `Planner error: ${msg}` } } as any);
        } catch {}
      } finally {
        this.busy = false;
        if (this.pendingTick) {
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
          const plannerId = this.deps.getPlannerAgentId?.() || 'planner';
          const principalLabel = `principal-for-${plannerId}`;
          const from = ev.author === 'user' ? principalLabel : plannerId;
          const to = ev.author === 'user' ? plannerId : principalLabel;
          lines.push(`<message from="${from}" to="${to}">`);
          if (safeText) lines.push(safeText);
          for (const a of atts) {
            const name = String(a?.name || 'attachment');
            const mime = String(a?.mimeType || 'text/plain');
            lines.push(`<attachment name="${name}" mimeType="${mime}" />`);
          }
          lines.push(`</message>`);
        } else if (ev.channel === 'planner-agent') {
          const plannerId = this.deps.getPlannerAgentId?.() || 'planner';
          const counterpartId = this.deps.getCounterpartAgentId?.() || 'agent';
          const from = ev.author === 'planner' ? plannerId : counterpartId;
          const to = ev.author === 'planner' ? counterpartId : plannerId;
          lines.push(`<message from="${from}" to="${to}">`);
          if (safeText) lines.push(safeText);
          for (const a of atts) {
            const name = String(a?.name || 'attachment');
            const mime = String(a?.mimeType || 'text/plain');
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
        const mimeType = String((f as any)?.mimeType || "text/plain");
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

    // Tool restrictions from deps + status gating
    const restrictions = this.deps.getToolRestrictions?.() || {};
    let omitUserMsg = !!restrictions.omitCoreTools?.includes('sendMessageToMyPrincipal');
    let omitRemoteMsg = !!restrictions.omitCoreTools?.includes('sendMessageToRemoteAgent');
    const omitScenarioTools = new Set(restrictions.omitScenarioTools || []);

    // Adaptive rule to prevent two consecutive sends to same party
    try {
      const lastMessage = [...this.eventLog].reverse().find(e => e.type === 'message') as any;
      if (lastMessage) {
        if (lastMessage.channel === 'user-planner' && lastMessage.author === 'planner') omitUserMsg = true;
        if (lastMessage.channel === 'planner-agent' && lastMessage.author === 'planner') omitRemoteMsg = true;
      }
    } catch {}

    // Status gating for tools
    const lastStatus = [...this.eventLog].reverse().find(e => e.type === 'status') as any;
    const statusNow = String(lastStatus?.payload?.state || '');

    // remote-agent messaging only when input-required
    const allowRemote = !statusNow || statusNow === 'input-required';
    if (!allowRemote) omitRemoteMsg = true;

    // // while 'working', also suppress user messaging (nothing needed)
    // if (statusNow === 'working') {
    //   omitUserMsg = true;
    // }

    // after 'completed', allow ONE user wrap-up; remote remains disabled
    if (statusNow === 'completed') {
      omitRemoteMsg = true;
      omitUserMsg = false;
    }

    // TOOLS section (core)
    parts.push("<TOOLS>");
    parts.push("Respond with exactly ONE JSON object describing your reasoning and chosen action.");
    parts.push("Schema: { reasoning: string, action: { tool: string, args: object } }");
    parts.push("");

    if (!omitRemoteMsg) {
      parts.push("// Send a message to the remote agent. Attachments by 'name'.");
      parts.push("interface SendMessageToRemoteAgentArgs { text?: string; attachments?: Array<{ name: string }>; finality?: 'none'|'turn'|'conversation'; }");
      parts.push("Tool: sendMessageToRemoteAgent: SendMessageToRemoteAgentArgs");
      parts.push("");
    }
    if (!omitUserMsg) {
      try {
        const scAny: any = this.scenario;
        const plannerId = this.deps.getPlannerAgentId?.() || this.myAgentId || '';
        const me = Array.isArray(scAny?.agents) ? scAny.agents.find((a: any) => a?.agentId === plannerId) : null;
        const pType = String(me?.principal?.type || '').trim();
        const pName = String(me?.principal?.name || '').trim();
        const typeLabel = pType ? (pType === 'individual' ? 'individual' : pType === 'organization' ? 'organization' : pType) : '';
        const descSuffix = pName && typeLabel ? ` (${typeLabel}: ${pName})` : (pName ? ` (${pName})` : '');
        parts.push(`// Send a message to your principal${descSuffix}.`);
      } catch {
        parts.push("// Send a message to your principal.");
      }
      parts.push("interface sendMessageToMyPrincipalArgs { text: string; attachments?: Array<{ name: string }>; }");
      parts.push("Tool: sendMessageToMyPrincipal: sendMessageToMyPrincipalArgs");
      parts.push("");
    }
    // Always-available small helpers
    parts.push("// Sleep until a new event arrives (no arguments).");
    parts.push("type SleepArgs = {};");
    parts.push("Tool: sleep: SleepArgs");
    parts.push("");

    parts.push("// Read a previously uploaded attachment by name (from AVAILABLE_FILES).");
    parts.push("interface ReadAttachmentArgs { name: string }");
    parts.push("Tool: readAttachment: ReadAttachmentArgs");
    parts.push("");

    parts.push("// Declare that you're fully done.");
    parts.push("interface DoneArgs { summary?: string }");
    parts.push("Tool: done: DoneArgs");

    // Scenario tools (respect omits)
    try {
      const sc = this.scenario;
      const plannerId2 = this.deps.getPlannerAgentId?.() || this.myAgentId || '';
      const agentDef = sc?.agents?.find(a => a.agentId === plannerId2);
      const allTools = agentDef?.tools || [];
      const enabledTools = allTools.filter(tool => !omitScenarioTools.has(tool.toolName));

      if (enabledTools.length) {
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
        parts.push("Scenario-Specific Tools:");
        for (const tool of enabledTools) {
          const name = tool.toolName;
          const desc = tool.description;
          parts.push(`// ${desc}`.trim());
          if (tool.inputSchema) {
            const iface = schemaToTs(tool.inputSchema);
            parts.push(`interface ${name}Args ${iface}`);
            parts.push(`Tool: ${name}: ${name}Args`);
          } else {
            parts.push(`interface ${name}Args { /* see description */ }`);
            parts.push(`Tool: ${name}: ${name}Args`);
          }
          parts.push('');
        }
      }
    } catch {}
    parts.push("</TOOLS>");
    parts.push("");

    // Suggested starting message (if none sent yet)
    try {
      const hasPlannerContact = this.eventLog.some(ev =>
        (ev.type === 'message' && ev.channel === 'planner-agent' && ev.author === 'planner')
      );
      if (!hasPlannerContact) {
        const scAny: any = this.scenario;
        const plannerId3 = this.deps.getPlannerAgentId?.() || this.myAgentId || '';
        const me = Array.isArray(scAny?.agents) ? scAny.agents.find((a: any) => a?.agentId === plannerId3) : null;
        const suggested: string | undefined = me?.messageToUseWhenInitiatingConversation || me?.initialMessage || undefined;
        if (suggested && String(suggested).trim()) {
          parts.push('<suggested_starting_message>');
          parts.push(String(suggested).trim());
          parts.push('</suggested_starting_message>');
          parts.push('');
        }
      }
    } catch {}

    // FINALIZATION reminder if terminal tool was used
    if (this.terminal.pending) {
      parts.push("<FINALIZATION_REMINDER>");
      parts.push("You have invoked a terminal tool that ends the conversation.");
      parts.push("Compose ONE final message to the remote agent:");
      parts.push("- Summarize the outcome and key reasons.");
      parts.push("- Attach the terminal tool's output files below.");
      parts.push("- Set finality to 'conversation'.");
      if (this.terminal.attachments.length) {
        parts.push("Files to attach:");
        for (const name of this.terminal.attachments) parts.push(`- ${name}`);
      }
      if (this.terminal.note) parts.push(`Note: ${this.terminal.note}`);
      parts.push("</FINALIZATION_REMINDER>");
      parts.push("");
    }

    parts.push("<RESPONSE>");
    parts.push("Output exactly one JSON object with fields 'reasoning' and 'action'. No extra commentary or code fences.");
    parts.push("</RESPONSE>");
    return parts.join("\n");
  }

  private async callLLM(prompt: string): Promise<{ content: string }> {
    this.llmProvider = this.deps.getLLMProvider();
    const maxAttempts = 3;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await this.llmProvider.complete({
          messages: [
            { role: 'system', content: 'You are a turn-based agent planner. Respond with JSON only.' },
            { role: 'user', content: prompt },
          ],
          model: this.deps.getModel?.(),
          temperature: 0.2,
          loggingMetadata: {},
        } as any);
        return { content: String(resp?.content ?? '') };
      } catch (e: any) {
        lastErr = e;
        if (attempt < maxAttempts) {
          const base = 200;
          const delay = base * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 50);
          try { await new Promise(res => setTimeout(res, delay)); } catch {}
          continue;
        }
      }
    }
    throw lastErr ?? new Error('LLM call failed');
  }

  private parseToolCallStrict(text: string): { reasoning: string; tool: string; args: any } | null {
    try {
      let raw = String(text || "").trim();
      const m = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
      if (m && m[1]) raw = m[1].trim();
      const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
      const objTxt = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
      const obj: any = JSON.parse(objTxt);
      if (obj && typeof obj === 'object') {
        if (obj.action && typeof obj.action === 'object' && typeof obj.action.tool === 'string') {
          const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
          const tool = String(obj.action.tool || '');
          const args = obj.action.args || {};
          if (tool) return { reasoning, tool, args };
        }
        if (obj.toolCall && typeof obj.toolCall === 'object' && typeof obj.toolCall.tool === 'string') {
          const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : (typeof obj.thought === 'string' ? obj.thought : '');
          const tool = String(obj.toolCall.tool || '');
          const args = obj.toolCall.args || {};
          if (tool) return { reasoning, tool, args };
        }
      }
      return null;
    } catch { return null; }
  }

  private parseAction(text: string): { reasoning: string; tool: string; args: any } {
    let raw = String(text || "").trim();
    const m = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
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
      return { reasoning: String((objTxt as any)?.reasoning || ""), tool: "sleep", args: { ms: 200 } };
    } catch {
      return { reasoning: "parse error", tool: "sleep", args: { ms: 200 } };
    }
  }

  // Terminal marker
  private markTerminal(status: 'success' | 'failure' | 'neutral', attachments: string[], note?: string) {
    this.terminal.pending = true;
    this.terminal.status = status;
    const seen = new Set(this.terminal.attachments);
    for (const a of attachments) {
      if (!seen.has(a)) { this.terminal.attachments.push(a); seen.add(a); }
    }
    if (note && !this.terminal.note) this.terminal.note = note;
  }

  // Index documents produced by tools into vault + documents map (filenames returned)
  public indexDocumentsFromResult(obj: any, opts?: { toolName?: string }): string[] {
    let found = 0;
    const created: string[] = [];
    const walk = (x: any) => {
      if (!x || typeof x !== 'object') return;
      if (typeof x.docId === 'string' || typeof x.name === 'string') {
        const name = String(x.name || x.docId || `result_${Date.now()}`);
        let contentType: string = String(x.contentType || 'text/markdown');
        let contentStr: string | undefined;
        if (typeof x.content === 'string') contentStr = x.content;
        else if (x.content && typeof x.content === 'object') {
          try { contentStr = JSON.stringify(x.content, null, 2); } catch { contentStr = String(x.content); }
          contentType = 'application/json';
        } else if (typeof x.text === 'string') contentStr = x.text;

        this.documents.set(name, { name, contentType, content: contentStr });
        try {
          this.deps.vault.addSynthetic(name, contentType, contentStr || '');
        } catch {}
        found++;
        created.push(name);
      }
      if (Array.isArray(x)) x.forEach(walk);
      else for (const k of Object.keys(x)) walk(x[k]);
    };
    try { walk(obj); } catch {}
    if (!found && obj && typeof obj === 'object') {
      const status = String((obj as any)?.status || '').toLowerCase();
      const isError = (obj as any)?.ok === false || typeof (obj as any)?.error === 'string' || status === 'error' || status === 'failed';
      if (!isError) {
        const tool = opts?.toolName ? String(opts.toolName).replace(/[^a-z0-9]+/gi,'_').toLowerCase() : 'result';
        const name = `synth_${tool}_${Date.now()}.json`;
        const contentType = 'application/json';
        const contentUtf8 = JSON.stringify(obj, null, 2);
        this.documents.set(name, { name, contentType, content: contentUtf8 });
        this.deps.vault.addSynthetic(name, contentType, contentUtf8);
        created.push(name);
      }
    }
    return created;
  }

  // Emit + post-emit hook (for post-completed single wrap-up)
  private emit<T extends EventType>(partial: Omit<StrictEvent & { type: T }, 'seq' | 'timestamp'>): StrictEvent {
    const ev = makeEvent(++this.seq, partial as any);
    assertEvent(ev);
    this.eventLog.push(ev);
    if (ev.type === 'tool_result') {
      try { this.indexDocumentsFromResult((ev as any)?.payload?.result); } catch {}
    }
    for (const cb of this.listeners) cb(ev);
    return ev;
  }

  private async tickOnce() {
    // Build TOOLS-gated prompt
    const prompt = this.buildPrompt();
    if (this.deps.onDebugPrompt) {
      try { this.deps.onDebugPrompt(prompt); } catch {}
    }

    let content: string = '';
    let parsed: { reasoning: string; tool: string; args: any } | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await this.callLLM(prompt);
      content = res.content;
      parsed = this.parseToolCallStrict(content);
      if (parsed) break;
      if (attempt < 3) {
        try { await new Promise(r => setTimeout(r, 200 * attempt)); } catch {}
      }
    }
    const { reasoning, tool, args } = parsed || this.parseAction(content);

    const lastSt = [...this.eventLog].reverse().find(e => e.type === 'status') as any;
    const statusNow = String(lastSt?.payload?.state || '');
    const canSendRemote = !lastSt || statusNow === 'input-required';

    // Core tools
    if (tool === "sleep") return;

    if (tool === "sendMessageToMyPrincipal") {
      const q = String(args?.text || args?.question || "").trim();
      if (q) this.emit({ type: 'message', channel: 'user-planner', author: 'planner', payload: { text: q } } as any);
      this.maybeTick();
      return;
    }

    if (tool === "readAttachment") {
      const name = String(args?.name || "").trim();
      const a = name ? this.deps.vault.getByName(name) : undefined;
      const ok = !!a && !a.private;
      const payload = ok
        ? { name, ok: true, size: a!.size, truncated: !!a!.summary, text_excerpt: a!.summary || undefined }
        : { name, ok: false };
      this.emit({ type: 'read_attachment', channel: 'tool', author: 'planner', payload, reasoning } as any);
      this.maybeTick();
      return;
    }

    if (tool === "done") {
      const summary = String(args?.summary || "").trim();
      if (summary) this.emit({ type: 'trace', channel: 'system', author: 'system', payload: { text: `Planner done: ${summary}` } } as any);
      this.finished = true;
      return;
    }

    if (tool === "sendMessageToRemoteAgent") {
      if (!canSendRemote) {
        const err = { ok: false, error: 'Conversation is not accepting remote messages (completed or not your turn). You may send a final message to the user instead.' } as any;
        this.emit({ type: 'tool_result', channel: 'tool', author: 'planner', payload: { result: err } } as any);
        return;
      }
      const text = String(args?.text || "");

      // Finality: force conversation if terminal pending
      const finRequested = String(args?.finality || '').toLowerCase();
      const finality =
        this.terminal.pending ? 'conversation'
        : finRequested === 'conversation' ? 'conversation'
        : finRequested === 'turn' ? 'turn'
        : 'turn';

      // Attachments default to terminal outputs if any
      const argAtts = Array.isArray(args?.attachments) ? args.attachments : undefined;
      const defaultAtts = this.terminal.pending ? this.terminal.attachments.map(name => ({ name })) : [];
      const atts = (argAtts && argAtts.length ? argAtts : defaultAtts) as Array<{ name: string }>;

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
        const err = { ok: false, error: `Could not send message becuse you included attachments that are unavailable: ${unresolved.join(', ')}` } as any;
        this.emit({ type: 'tool_result', channel: 'tool', author: 'planner', payload: { result: err } } as any);
        return;
      }

      // Emit planner-agent message with finality hint for bridge
      this.emit({
        type: 'message',
        channel: 'planner-agent',
        author: 'planner',
        payload: {
          text,
          attachments: atts && atts.length ? atts.map((a: any)=>({ name: String(a.name), mimeType: String(a.mimeType || 'text/plain') })) : undefined,
          finality
        }
      } as any);

      if (this.deps.task) {
        if (!this.deps.task.getTaskId?.())
          Promise.resolve().then(() => {(this.deps.task as any).startNew?.(parts as any);});
        else
          Promise.resolve().then(() => {(this.deps.task as any).send?.(parts as any);});
      }

      if (finality === "conversation") {
        this.terminal.pending = false;
      } else {
        this.maybeTick();
      }
      return;
    }

    // Scenario tools
    const plannerId = this.deps.getPlannerAgentId?.() || this.myAgentId || '';
    const agentDef = this.scenario?.agents?.find(a => a.agentId === plannerId);
    const toolDef = agentDef?.tools?.find(t => t.toolName === tool);

    if (toolDef) {
      const callId = `call_${Date.now()}`;
      this.emit({ type: 'tool_call', channel: 'tool', author: 'planner', payload: { name: tool, args }, reasoning } as any);

      try {
        if (!this.oracle) {
          if (!this.llmProvider) throw new Error('LLM provider not available');
          this.oracle = new ToolSynthesisService(this.llmProvider);
        }

        const conversationHistory = this.buildXmlHistory();
        const result = await this.oracle.execute({
          tool: {
            toolName: toolDef.toolName,
            description: toolDef.description,
            synthesisGuidance: toolDef.synthesisGuidance,
            inputSchema: toolDef.inputSchema,
            endsConversation: toolDef.endsConversation,
            conversationEndStatus: toolDef.conversationEndStatus,
          },
          args: args || {},
          agent: {
            agentId: plannerId,
            principal: agentDef?.principal,
            situation: agentDef?.situation,
            systemPrompt: agentDef?.systemPrompt,
            goals: agentDef?.goals,
          },
          scenario: this.scenario,
          conversationHistory,
          omitHistory: true,
          leadingThought: reasoning || undefined,
        } as any);

        const filenames = this.indexDocumentsFromResult(result?.output, { toolName: tool });

        // If terminal, mark + encourage finalization on next tick
        if (toolDef.endsConversation) {
          const status = toolDef.conversationEndStatus || 'neutral';
          const output = result?.output;
          let note: string | undefined;
          if (output && typeof output === 'object') {
            const summary = (output as { summary?: unknown }).summary;
            const noteField = (output as { note?: unknown }).note;
            if (typeof summary === 'string') {
              note = summary;
            } else if (typeof noteField === 'string') {
              note = noteField;
            }
          }
          this.markTerminal(status, filenames, note);
        }

        this.turnScratch.toolCalls.push({ callId, name: tool, args, result: result?.output });
        this.emit({ type: 'tool_result', channel: 'tool', author: 'planner', payload: { result: result?.output }, reasoning } as any);
      } catch (e: any) {
        const err = { ok: false, error: String(e?.message ?? e) };
        this.turnScratch.toolCalls.push({ callId, name: tool, args, result: err });
        this.emit({ type: 'tool_result', channel: 'tool', author: 'planner', payload: { result: err }, reasoning } as any);
      } finally {}

      this.maybeTick();
      return;
    }

    // Unknown tool → sleep
  }
}
