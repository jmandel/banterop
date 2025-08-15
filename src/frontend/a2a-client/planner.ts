import { A2AClient } from "./a2a-client";
import type { A2APart } from "./a2a-types";
import { AttachmentVault } from "./attachments-vault";
import type { LLMProvider, LLMStepContext, ToolCall, ToolEvent } from "./llm-types";
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
  private loopCount = 0;
  private lastFrontCount = 0; // for passthrough: track forwarded front messages
  private activeStream?: AbortController;
  private lastAgentMsgId?: string;
  private lastUserCount = 0;
  private lastStatus?: import('./a2a-types').A2AStatus;

  constructor(private opts: PlannerDeps) {}

  start() {
    if (this.running) return;
    console.log("[Planner] Starting planner loop");
    this.running = true;
    void this.loop();
  }
  
  stop() { 
    console.log("[Planner] Stopping planner loop");
    this.running = false; 
  }

  private buildLLMCtx(): LLMStepContext {
    return {
      instructions: this.opts.getInstructions(),
      goals: this.opts.getGoals(),
      status: this.opts.store.getStatus(),
      policy: this.opts.getPolicy(),
      counterpartHint: this.opts.getCounterpartHint?.(),
      available_files: this.opts.vault.listForPlanner(),
      task_history_full: this.opts.store.getPlannerFullHistory(),
      user_mediator_recent: this.opts.getUserMediatorRecent(),
      tool_events_recent: this.toolEvents.slice(-8),
    };
  }

  // passthrough sending is coordinated by the host (App) to avoid duplicates
  private async passthroughTick(_ctx: LLMStepContext) { return false; }

  private async handleSendToAgent(args: any) {
    const txt = String(args?.text ?? "");
    const atts = Array.isArray(args?.attachments) ? args.attachments : [];

    const parts: A2APart[] = [];
    if (txt) parts.push({ kind: "text", text: txt });
    for (const a of atts) {
      if (!a || typeof a.name !== "string") continue;
      const byName = this.opts.vault.getByName(a.name);
      if (byName) {
        parts.push({ kind: "file", file: { name: byName.name, mimeType: byName.mimeType, bytes: byName.bytes } });
      } else {
        const name = String(a.name || "attachment");
        const mimeType = String(a.mimeType || "application/octet-stream");
        const bytes = typeof a.bytes === "string" ? a.bytes : undefined;
        const uri = typeof a.uri === "string" ? a.uri : undefined;
        parts.push({ kind: "file", file: { name, mimeType, ...(bytes ? { bytes } : {}), ...(uri ? { uri } : {}) } });
      }
    }

    if (txt) this.opts.onSendToAgentEcho?.(txt);

    const hasTask = !!this.opts.store.getTaskId();
    try {
      // Always use message/stream. Close any prior stream first.
      try { this.activeStream?.abort(); } catch {}
      const ac = new AbortController();
      this.activeStream = ac;
      const taskId = this.opts.store.getTaskId();
      for await (const frame of this.opts.a2a.messageStreamParts(parts, taskId, ac.signal)) {
        this.opts.store.ingestFrame(frame);
      }
    } catch (e: any) {
      this.opts.onSystem(`stream error: ${String(e?.message ?? e)}`);
    } finally {
      if (this.activeStream) this.activeStream = undefined;
      // If stream ended but task remains active (not terminal and not waiting for user), resubscribe for durability
      try {
        const st = this.opts.store.getStatus();
        const hasId = !!this.opts.store.getTaskId();
        if (hasId && st !== "completed" && st !== "failed" && st !== "canceled" && st !== "input-required") {
          this.opts.store.resubscribe();
        }
      } catch {}
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
        const ctx: LLMStepContext = this.buildLLMCtx();
        // Deduplicate triggers: only act when there is a new agent message or user text or status change
        const agentLog = (this.opts.store as any).getAgentLogEntries?.() || [];
        const lastAgent = agentLog.filter((e: any) => e.role === 'agent' && !e.partial).slice(-1)[0];
        const userCount = this.opts.getUserMediatorRecent().length;
        console.debug(`[Planner] Stimulus status=${ctx.status} lastAgent=${lastAgent?.id || '-'} userCount=${userCount}`);
        const sameAgent = !!this.lastAgentMsgId && !!lastAgent && this.lastAgentMsgId === lastAgent.id;
        const sameUsers = this.lastUserCount === userCount;
        const sameStatus = this.lastStatus === ctx.status;
        if (sameAgent && sameUsers && sameStatus) {
          await this.opts.waitNextEvent();
          continue;
        }
        this.lastAgentMsgId = lastAgent?.id;
        this.lastUserCount = userCount;
        this.lastStatus = ctx.status;
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

        if (kind === "ask_user") {
          const q = String((tool as any).args?.question ?? "").trim();
          if (q) this.opts.onAskUser(q);
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
