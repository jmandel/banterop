import type { A2APart, A2ATask } from "./a2a-types";
import { AttachmentVault } from "./attachments-vault";
import type { LLMProvider, LLMStepContext, ToolCall, ToolEvent, PlannerEvent } from "./llm-types";
import { inspectAttachment } from "./attachment-inspector";
import { A2ATaskClient } from "./a2a-task-client";

export type PlannerHooks = {
  onSystem: (text: string) => void;
  onAskUser: (question: string) => void;
  onSendToAgentEcho?: (text: string) => void;
};

export type PlannerDeps = PlannerHooks & {
  provider?: LLMProvider; // optional in passthrough mode
  task: A2ATaskClient;
  vault: AttachmentVault;
  cancelTask?: () => Promise<void>; // optional task cancellation

  getPolicy: () => { has_task: boolean; planner_mode?: "passthrough" | "autostart" | "approval" };
  getInstructions: () => string;
  getGoals: () => string;
  getUserMediatorRecent: () => Array<{ role: "user" | "planner" | "system"; text: string }>;
  getCounterpartHint?: () => string | undefined;
  waitNextEvent: () => Promise<void>;
};

const MAX_EVENT_TEXT = 80000; // Allow much larger attachment content in events

export class Planner {
  private running = false;
  private busy = false;
  private toolEvents: ToolEvent[] = [];
  private plannerEvents: PlannerEvent[] = [];
  // No version flags; rely solely on the event log to gate sends
  private previousTask: A2ATask | null = null;

  constructor(private opts: PlannerDeps) {}

  start() {
    if (this.running) return;
    console.log("[Planner] Starting planner loop");
    this.running = true;
    // Seed log with init and current status
    const initEv: PlannerEvent = { type: 'init', at: new Date().toISOString() } as any;
    this.plannerEvents.push(initEv);
    this.logStatus(this.opts.task.getStatus());

    // Subscribe to consolidated task updates
    this.opts.task.on('new-task', (task: A2ATask) => {
      console.log('[Planner][TaskUpdate] new task:', task);
      try { this.handleTaskUpdate(this.previousTask, task); } catch {}
      this.previousTask = task;
      this.maybeTick();
    });
    this.maybeTick();
  }
  
  stop() { 
    console.log("[Planner] Stopping planner loop");
    this.running = false; 
  }

  // Exposed to App: record a user message
  recordUserReply(text: string) {
    const t = String(text || '').trim();
    if (!t) return;
    const ev: PlannerEvent = { type: 'user_message', at: new Date().toISOString(), text: t } as any;
    this.plannerEvents.push(ev);
    this.maybeTick();
  }

  private logStatus(s: import('./a2a-types').A2AStatus | "initializing") {
    const ev: PlannerEvent = { type: 'status', at: new Date().toISOString(), status: s } as any;
    this.plannerEvents.push(ev);
  }

  private buildLLMCtx(): LLMStepContext {
    const task = this.opts.task.getTask();
    const full = (task?.history || []).map((m:any) => ({ role: m.role, text: (m.parts||[]).filter((p:any)=>p?.kind==='text').map((p:any)=>p.text).join('\n') || '' }));
    const priorMediator = full.filter((m) => m.role === 'user').length;
    return {
      instructions: this.opts.getInstructions(),
      goals: this.opts.getGoals(),
      status: this.opts.task.getStatus(),
      policy: this.opts.getPolicy(),
      counterpartHint: this.opts.getCounterpartHint?.(),
      available_files: this.opts.vault.listForPlanner(),
      task_history_full: full,
      user_mediator_recent: this.opts.getUserMediatorRecent(),
      tool_events_recent: this.toolEvents.slice(-8),
      planner_events_recent: this.plannerEvents, // Pass all events, let LLM provider handle slicing
      prior_mediator_messages: priorMediator,
    };
  }

  // passthrough sending is coordinated by the host (App) to avoid duplicates
  private async passthroughTick(_ctx: LLMStepContext) { return false; }

  private async handleSendToAgent(args: any) {
    const txt = String(args?.text ?? "");
    const atts = Array.isArray(args?.attachments) ? args.attachments : [];

    const parts: A2APart[] = [];
    if (txt) parts.push({ kind: "text", text: txt });
    const missing: string[] = [];
    for (const a of atts) {
      if (!a || typeof a.name !== "string") continue;
      const byName = this.opts.vault.getByName(a.name);
      if (byName) {
        parts.push({ kind: "file", file: { name: byName.name, mimeType: byName.mimeType, bytes: byName.bytes } });
      } else if (typeof a.bytes === 'string' || typeof a.uri === 'string') {
        const name = String(a.name || "attachment");
        const mimeType = String(a.mimeType || "application/octet-stream");
        const bytes = typeof a.bytes === "string" ? a.bytes : undefined;
        const uri = typeof a.uri === "string" ? a.uri : undefined;
        parts.push({ kind: "file", file: { name, mimeType, ...(bytes ? { bytes } : {}), ...(uri ? { uri } : {}) } });
      } else {
        missing.push(String(a.name || 'attachment'));
      }
    }

    if (missing.length) {
      console.warn('[Planner][Send] Aborting send_to_agent: missing attachments', missing);
      const ev: PlannerEvent = { type: 'error', at: new Date().toISOString(), code: 'attach_missing', details: { names: missing } } as any;
      this.plannerEvents.push(ev);
      this.opts.onSystem(`Attachment(s) not found: ${missing.join(', ')} — only existing documents can be attached.`);
      return;
    }

    if (txt) this.opts.onSendToAgentEcho?.(txt);
    const hasTask = !!this.opts.task.getTaskId();
    console.log('[Planner][Send] Preparing send_to_agent', { hasTask, textLen: txt.length, atts: atts?.length || 0 });
    // Record planner event for sent message and enqueue
    const attachmentInfo = atts.length ? atts.map((a: any) => ({ name: a.name || 'attachment', mimeType: a.mimeType || 'application/octet-stream' })) : undefined;
    try { this.plannerEvents.push({ type: 'sent_to_agent', at: new Date().toISOString(), text: txt || undefined, attachments: attachmentInfo } as any); } catch {}

    try {
      if (!hasTask) {
        console.log('[Planner][Send] No task yet; starting new task via stream');
        await this.opts.task.startNew(parts);
        console.log('[Planner][Send] startNew completed');
      } else {
        console.log('[Planner][Send] Sending on existing task', this.opts.task.getTaskId());
        await this.opts.task.send(parts);
        console.log('[Planner][Send] send completed');
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      console.warn('[Planner][Send] error:', msg);
      this.opts.onSystem(`send error: ${msg}`);
    }
  }

  private async handleReadAttachment(args: any) {
    const name = String(args?.name || "");
    const purpose = typeof args?.purpose === "string" ? args.purpose : undefined;

    const res = await inspectAttachment(this.opts.vault, name, purpose);
    
    // Add to planner events for proper chronological tracking
    const plannerEv: PlannerEvent = {
      type: 'read_attachment',
      at: new Date().toISOString(),
      name,
      purpose,
      result: {
        ok: res.ok,
        reason: res.reason,
        size: res.size,
        truncated: res.truncated,
        text_excerpt: res.text ? res.text.slice(0, MAX_EVENT_TEXT) : undefined
      }
    } as any;
    this.plannerEvents.push(plannerEv);
    
    // Also keep in tool events for detailed context
    const ev: ToolEvent = {
      tool: "read_attachment",
      args: { name, purpose },
      result: {
        ok: res.ok,
        private: res.private,
        reason: res.reason,
        mimeType: res.mimeType,
        size: res.size,
        description: res.description,
        truncated: res.truncated,
        text_excerpt: res.text ? res.text.slice(0, MAX_EVENT_TEXT) : undefined,
      },
      at: new Date().toISOString(),
    };
    this.toolEvents.push(ev);

    if (!res.ok) {
      this.opts.onSystem(`Read blocked for "${name}" (${res.reason || "unknown"}).`);
    } else if (res.description) {
      this.opts.onSystem(`Read "${name}": ${res.description}`);
    } else if (res.text) {
      this.opts.onSystem(`Read "${name}": ${res.text.length} chars${res.truncated ? " (truncated)" : ""}.`);
    }
  }
  private maybeTick() {
    if (!this.running) return;
    if (!this.opts.provider || this.opts.getPolicy().planner_mode === 'passthrough') return;
    if (this.busy) return;
    console.debug('[Planner] maybeTick: scheduling tick', this.plannerEvents);
    const status = this.opts.task.getStatus();
    const allowSendNow = this.canSendFromLog();
    const ctx = this.buildLLMCtx();
    console.debug(`[Planner] Tick status=${status}`);
    this.busy = true;
    (async () => {
      try {
        const tool = await this.opts.provider!.generateToolCall(ctx);
        if (!tool || typeof (tool as any).tool !== 'string') return;
        const kind = (tool as any).tool as ToolCall['tool'];
        console.log(`[Planner] Executing tool: ${kind}`, (tool as any).args);
        if (kind === 'sleep') {
          const ms = Math.max(0, Math.min(1000, Number((tool as any).args?.ms ?? 0)));
          await new Promise((r) => setTimeout(r, ms));
          return;
        }
        if (kind === 'send_to_local_user' || kind === 'ask_user') {
          const q = String((tool as any).args?.text ?? (tool as any).args?.question ?? '').trim();
          if (q) {
            this.opts.onAskUser(q);
            this.plannerEvents.push({ type: 'asked_user', at: new Date().toISOString(), question: q } as any);
          }
          return;
        }
        if (kind === 'done') {
          const summary = String((tool as any).args?.summary ?? '');
          if (summary) this.opts.onSystem(`Planner done: ${summary}`);
          // Cancel the task if it's still active
          const status = this.opts.task.getStatus();
          if (status !== 'completed' && status !== 'failed' && status !== 'canceled') {
            if (this.opts.cancelTask) {
              try {
                await this.opts.cancelTask();
                this.opts.onSystem('Task canceled.');
              } catch (e: any) {
                console.warn('[Planner] Failed to cancel task:', e);
              }
            }
          }
          return;
        }
        if (kind === 'read_attachment' || kind === 'inspect_attachment') { 
          await this.handleReadAttachment((tool as any).args ?? {}); 
          // After reading an attachment, we have new info - schedule another tick
          setTimeout(() => this.maybeTick(), 0);
          return; 
        }
        if (kind === 'send_to_agent') {
          if (!allowSendNow) {
            this.plannerEvents.push({ type: 'error', at: new Date().toISOString(), code: 'send_not_allowed', details: { reason: `status=${status}` } } as any);
            this.opts.onSystem(`Send blocked: not our turn (status=${status}).`);
            console.log('[Planner] send_to_agent skipped: not our turn');
            return;
          }
          await this.handleSendToAgent((tool as any).args ?? {});
        }
      } catch (e: any) {
        this.opts.onSystem(`LLM error: ${String(e?.message ?? e)}`);
      } finally {
        this.busy = false;
      }
    })();
  }

  private canSendFromLog(): boolean {
    // Find the last status event
    let lastStatusIdx = -1;
    for (let i = this.plannerEvents.length - 1; i >= 0; i--) {
      const e = this.plannerEvents[i] as any;
      if (e?.type === 'status') { lastStatusIdx = i; break; }
    }
    const hasTask = !!this.opts.task.getTaskId();
    // console.log('[Planner] canSendFromLog', { hasTask, lastStatusIdx, events: this.plannerEvents });
    
    if (lastStatusIdx === -1) return !hasTask; // initial turn allowed when no task yet
    const lastStatusEv: any = this.plannerEvents[lastStatusIdx];
    if (!["input-required", "initializing"].includes(lastStatusEv?.status)) return false;

    // Ensure there is no response_submitted (aka sent_to_agent) after this status
    for (let i = this.plannerEvents.length - 1; i > lastStatusIdx; i--) {
      const e = this.plannerEvents[i] as any;
      if (e?.type === 'sent_to_agent') return false;
    }
    return true;
  }

  private handleTaskUpdate(prev: A2ATask | null, next: A2ATask) {
    // Status change
    if (!prev || (prev.status?.state !== next.status?.state)) this.logStatus(next.status?.state || 'initializing');
    // New agent messages
    const prevIds = new Set((prev?.history || []).map((m: any) => m.messageId));
    for (const m of (next.history || [])) {
      if (!prevIds.has(m.messageId) && m.role === 'agent') {
        const text = String((m.parts || []).filter((p:any)=>p?.kind==='text').map((p:any)=>p.text).join('\n') || '');
        this.plannerEvents.push({ type: 'agent_message', at: new Date().toISOString(), text: text || undefined } as any);
        const atts = (m.parts || []).filter((p:any)=>p?.kind==='file').map((p:any)=>({ name: p.file?.name, mimeType: p.file?.mimeType, bytes: p.file?.bytes }))
          .filter((a:any)=>a?.name && a?.mimeType);
        if (atts.length) {
          for (const a of atts) {
            this.plannerEvents.push({ type: 'agent_document_added', at: new Date().toISOString(), name: a.name, mimeType: a.mimeType } as any);
            if (a.bytes) { try { this.opts.vault.addFromAgent(a.name, a.mimeType, a.bytes); } catch {} }
          }
        }
      }
    }
  }
}
