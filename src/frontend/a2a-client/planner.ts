import { A2AClient } from "./a2a-client";
import type { A2APart } from "./a2a-types";
import { AttachmentVault } from "./attachments-vault";
import type { LLMProvider, LLMStepContext, ToolCall, ToolEvent, PlannerEvent } from "./llm-types";
import { TaskHistoryStore } from "./task-history";
import { inspectAttachment } from "./attachment-inspector";

export type PlannerHooks = {
  onSystem: (text: string) => void;
  onAskUser: (question: string) => void;
  onSendToAgentEcho?: (text: string) => void;
};

export type PlannerDeps = PlannerHooks & {
  provider?: LLMProvider; // optional in passthrough mode
  a2a: A2AClient;
  store: TaskHistoryStore;
  vault: AttachmentVault;

  getPolicy: () => { has_task: boolean; planner_mode?: "passthrough" | "autostart" | "approval" };
  getInstructions: () => string;
  getGoals: () => string;
  getUserMediatorRecent: () => Array<{ role: "user" | "planner" | "system"; text: string }>;
  getCounterpartHint?: () => string | undefined;
  waitNextEvent: () => Promise<void>;
};

const MAX_EVENT_TEXT = 12000;

export class Planner {
  private running = false;
  private toolEvents: ToolEvent[] = [];
  private plannerEvents: PlannerEvent[] = [];
  private eventQueue: PlannerEvent[] = [];
  private eventSeen = new Set<string>();
  private lastDecisionIndex = 0;
  private hasLiveSSE = false;
  private loopCount = 0;
  private lastFrontCount = 0; // for passthrough: track forwarded front messages
  private activeStream?: AbortController;
  private lastAgentMsgId?: string;
  private agentMsgSeen = new Set<string>();
  private lastUserCount = 0;
  private lastStatus?: import('./a2a-types').A2AStatus;
  private lastStimKey?: string;

  constructor(private opts: PlannerDeps) {}

  start() {
    if (this.running) return;
    console.log("[Planner] Starting planner loop");
    this.running = true;
    // Seed queue with an init + current status event to guarantee first turn
    try {
      const initEv: PlannerEvent = { type: 'init', at: new Date().toISOString() } as any;
      this.plannerEvents.push(initEv);
      this.enqueueEvent(initEv);
      const curStatus = this.opts.store.getStatus();
      const sev: PlannerEvent = { type: 'status', at: new Date().toISOString(), status: curStatus } as any;
      this.plannerEvents.push(sev);
      this.enqueueEvent(sev);
      // Initialize lastStatus so the first loop doesn't immediately duplicate the same status
      this.lastStatus = curStatus;
    } catch {}
    void this.loop();
  }
  
  stop() { 
    console.log("[Planner] Stopping planner loop");
    this.running = false; 
  }

  // Exposed to App: record a user reply
  recordUserReply(text: string) {
    const t = String(text || '').trim();
    if (!t) return;
    const ev: PlannerEvent = { type: 'user_reply', at: new Date().toISOString(), text: t } as any;
    this.plannerEvents.push(ev);
    this.enqueueEvent(ev);
  }

  private evKey(ev: PlannerEvent): string {
    if (ev.type === 'init') return `init|${ev.at}`;
    if (ev.type === 'asked_user') return `asked_user|${ev.at}|${ev.question}`;
    if (ev.type === 'user_reply') return `user_reply|${ev.at}|${ev.text}`;
    if (ev.type === 'sent_to_agent') return `sent_to_agent|${ev.at}|${ev.text || ''}|${(ev.attachments||[]).map(a=>`${a.name}:${a.mimeType}`).join(',')}`;
    if (ev.type === 'agent_message') return `agent_message|${ev.at}|${ev.text || ''}`;
    if (ev.type === 'agent_document_added') return `agent_document_added|${ev.at}|${ev.name}|${ev.mimeType}`;
    if (ev.type === 'status') return `status|${ev.at}|${(ev as any).status}`;
    return JSON.stringify(ev);
  }

  private enqueueEvent(ev: PlannerEvent) {
    const key = this.evKey(ev);
    if (this.eventSeen.has(key)) return;
    this.eventSeen.add(key);
    this.eventQueue.push(ev);
  }

  private buildLLMCtx(): LLMStepContext {
    const full = this.opts.store.getPlannerFullHistory();
    const priorMediator = full.filter((m) => m.role === 'user').length;
    return {
      instructions: this.opts.getInstructions(),
      goals: this.opts.getGoals(),
      status: this.opts.store.getStatus(),
      policy: this.opts.getPolicy(),
      counterpartHint: this.opts.getCounterpartHint?.(),
      available_files: this.opts.vault.listForPlanner(),
      task_history_full: full,
      user_mediator_recent: this.opts.getUserMediatorRecent(),
      tool_events_recent: this.toolEvents.slice(-8),
      planner_events_recent: this.plannerEvents.slice(-20),
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
      const ev: PlannerEvent = { type: 'error', at: new Date().toISOString(), code: 'attach_missing', details: { names: missing } } as any;
      this.plannerEvents.push(ev);
      this.enqueueEvent(ev);
      // Do not let this internal event immediately trigger another LLM step
      this.lastDecisionIndex = this.eventQueue.length;
      this.opts.onSystem(`Attachment(s) not found: ${missing.join(', ')} — only existing documents can be attached.`);
      return;
    }

    if (txt) this.opts.onSendToAgentEcho?.(txt);
    // Record planner event for sent message and enqueue
    try {
      const simpleAtts = atts.map((a: any) => ({ name: String(a?.name || 'attachment'), mimeType: String(a?.mimeType || 'application/octet-stream') }));
      const sev: PlannerEvent = { type: 'sent_to_agent', at: new Date().toISOString(), text: txt || undefined, attachments: simpleAtts.length ? simpleAtts : undefined } as any;
      this.plannerEvents.push(sev);
      this.enqueueEvent(sev);
      // Neutralize immediate self-trigger from planner-originated event
      this.lastDecisionIndex = this.eventQueue.length;
    } catch {}

    const hasTask = !!this.opts.store.getTaskId();
    if (!this.hasLiveSSE) {
      if (!hasTask) {
        // First turn: open message/stream to create task and establish SSE
        try {
          try {
            if (this.activeStream) {
              console.warn(`[SSEAbort] Planner: aborting prior activeStream before first-turn send (reason=new-initial-send)`);
              this.activeStream.abort();
            }
          } catch {}
          const ac = new AbortController();
          this.activeStream = ac;
          this.hasLiveSSE = true;
          for await (const frame of this.opts.a2a.messageStreamParts(parts, undefined, ac.signal)) {
            this.opts.store.ingestFrame(frame);
          }
        } catch (e: any) {
          this.opts.onSystem(`stream error: ${String(e?.message ?? e)}`);
          this.hasLiveSSE = false;
        } finally {
          if (this.activeStream) this.activeStream = undefined;
          // Ensure durable SSE via resubscribe if stream ended
          try { this.opts.store.resubscribe(); this.hasLiveSSE = true; } catch {}
        }
      } else {
        // We have a task but no live SSE; re-subscribe and send via message/send
        try { this.opts.store.resubscribe(); this.hasLiveSSE = true; } catch {}
        try {
          const t = await this.opts.a2a.messageSendParts(parts, this.opts.store.getTaskId());
          this.opts.store.ingestFrame({ result: t } as any);
        } catch (e: any) {
          this.opts.onSystem(`send error: ${String(e?.message ?? e)}`);
        }
      }
    } else {
      // Live SSE present: just send
      try {
        const t = await this.opts.a2a.messageSendParts(parts, this.opts.store.getTaskId());
        this.opts.store.ingestFrame({ result: t } as any);
      } catch (e: any) {
        this.opts.onSystem(`send error: ${String(e?.message ?? e)}`);
      }
    }
  }

  private async handleInspectAttachment(args: any) {
    const name = String(args?.name || "");
    const purpose = typeof args?.purpose === "string" ? args.purpose : undefined;

    const res = await inspectAttachment(this.opts.vault, name, purpose);
    const ev: ToolEvent = {
      tool: "inspect_attachment",
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
      this.opts.onSystem(`Inspection blocked for "${name}" (${res.reason || "unknown"}).`);
    } else if (res.description) {
      this.opts.onSystem(`Inspected "${name}": ${res.description}`);
    } else if (res.text) {
      this.opts.onSystem(`Inspected "${name}": ${res.text.length} chars${res.truncated ? " (truncated)" : ""}.`);
    }
  }

  private async loop() {
    try {
      while (this.running) {
        this.loopCount++;
        // Reconcile latest agent events and attachments BEFORE building ctx so prompt sees fresh state
        const agentLog = (this.opts.store as any).getAgentLogEntries?.() || [];
        const lastAgent = agentLog.filter((e: any) => e.role === 'agent' && !e.partial).slice(-1)[0];
        const userCount = this.opts.getUserMediatorRecent().length;
        // Enqueue status change event (including initial status)
        const curStatus = this.opts.store.getStatus();
        if (this.lastStatus !== curStatus) {
          const sev = { type: 'status', at: new Date().toISOString(), status: curStatus } as any as PlannerEvent;
          this.plannerEvents.push(sev);
          this.enqueueEvent(sev);
        }
        // Robust agent message ingestion: enqueue any new agent messages not yet recorded
        try {
          const newAgentMsgs = agentLog.filter((e: any) => e.role === 'agent' && !e.partial);
          for (const m of newAgentMsgs) {
            if (m?.id && !this.agentMsgSeen.has(m.id)) {
              this.agentMsgSeen.add(m.id);
              const text = String(m.text || '');
              this.plannerEvents.push({ type: 'agent_message', at: new Date().toISOString(), text: text || undefined });
              const attachments = (m as any).attachments as Array<{ name: string; mimeType: string; bytes?: string; uri?: string }> | undefined;
              if (attachments && attachments.length) {
                for (const a of attachments) {
                  if (a?.name && a?.mimeType) {
                    this.plannerEvents.push({ type: 'agent_document_added', at: new Date().toISOString(), name: a.name, mimeType: a.mimeType });
                    if (a.bytes) {
                      try { this.opts.vault.addFromAgent(a.name, a.mimeType, a.bytes); } catch {}
                    }
                  }
                }
              }
              this.enqueueEvent(this.plannerEvents[this.plannerEvents.length - 1]!);
            }
          }
        } catch {}

        // Now build a fresh context that includes any new events/files
        const ctx: LLMStepContext = this.buildLLMCtx();
        console.debug(`[Planner] Stimulus status=${ctx.status} lastAgent=${lastAgent?.id || '-'} userCount=${userCount}`);
        // Drive LLM strictly by queue growth
        const qlen = this.eventQueue.length;
        if (this.lastDecisionIndex === qlen) {
          await this.opts.waitNextEvent();
          continue;
        }
        try { console.log('[Planner] EventQueue size', qlen, this.eventQueue.slice()); } catch {}
        this.lastAgentMsgId = lastAgent?.id;
        this.lastUserCount = userCount;
        this.lastStatus = ctx.status;
        this.lastDecisionIndex = qlen;
        console.log(`[Planner] Loop iteration ${this.loopCount}, status: ${ctx.status}`);

        // Passthrough mode: thin relay without LLM
        if (ctx.policy.planner_mode === "passthrough" || !this.opts.provider) {
          await this.opts.waitNextEvent();
          continue;
        }

        let tool: ToolCall | null = null;
        try {
          tool = await this.opts.provider.generateToolCall(ctx);
        } catch (e: any) {
          this.opts.onSystem(`LLM error: ${String(e?.message ?? e)}`);
          await this.opts.waitNextEvent();
          continue;
        }

        if (!tool || typeof (tool as any).tool !== "string") {
          console.log("[Planner] No valid tool returned, waiting for next event");
          await this.opts.waitNextEvent();
          continue;
        }

        const kind = (tool as any).tool as ToolCall["tool"];
        console.log(`[Planner] Executing tool: ${kind}`, (tool as any).args);

        if (kind === "sleep") {
          const ms = Math.max(0, Math.min(1000, Number((tool as any).args?.ms ?? 0)));
          await new Promise((r) => setTimeout(r, ms));
          continue;
        }

        if (kind === "ask_user" || kind === "send_to_local_user") {
          const q = String((tool as any).args?.question ?? (tool as any).args?.text ?? "").trim();
          if (q) {
            this.opts.onAskUser(q);
            const ev: PlannerEvent = { type: 'asked_user', at: new Date().toISOString(), question: q } as any;
            this.plannerEvents.push(ev);
            this.enqueueEvent(ev);
            // Prevent this enqueue from causing an immediate extra LLM iteration
            this.lastDecisionIndex = this.eventQueue.length;
          }
          await this.opts.waitNextEvent();
          continue;
        }

        if (kind === "done") {
          const summary = String((tool as any).args?.summary ?? "");
          if (summary) this.opts.onSystem(`Planner done: ${summary}`);
          await this.opts.waitNextEvent();
          continue;
        }

        if (kind === "send_to_agent") {
          // Gate: allow initial send (to create task) OR when it's our turn (input-required)
          const hasTask = !!this.opts.store.getTaskId();
          const curStatus = this.opts.store.getStatus();
          const allowSend = !hasTask || curStatus === 'input-required';
          if (!allowSend) {
            const ev: PlannerEvent = { type: 'error', at: new Date().toISOString(), code: 'send_not_allowed', details: { reason: `status=${curStatus}` } } as any;
            this.plannerEvents.push(ev);
            this.enqueueEvent(ev);
            // Prevent immediate re-entry; wait for a real event (status/user/agent)
            this.lastDecisionIndex = this.eventQueue.length;
            this.opts.onSystem(`Send blocked: not our turn (status=${curStatus}).`);
            await this.opts.waitNextEvent();
            continue;
          }
          await this.handleSendToAgent((tool as any).args ?? {});
          // If turn closed and we're now waiting for user input, re-evaluate immediately
          if (this.opts.store.getStatus() === 'input-required') {
            console.debug('[Planner] Turn boundary reached (input-required). Continuing without wait.');
            continue;
          }
          await this.opts.waitNextEvent();
          continue;
        }

        if (kind === "inspect_attachment") {
          await this.handleInspectAttachment((tool as any).args ?? {});
          await this.opts.waitNextEvent();
          continue;
        }

        await this.opts.waitNextEvent();
      }
    } finally {
      this.running = false;
    }
  }
}
