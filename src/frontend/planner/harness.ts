import type { Fact, ProposedFact, Planner, PlanInput, PlanContext, LlmProvider } from "../../shared/journal-types";
import { rid } from "../../shared/core";

export class PlannerHarness<Cfg = unknown> {
  constructor(
    private getFacts: () => ReadonlyArray<Fact>,
    private getHead: () => number,
    private append: (batch: ProposedFact[], opts?: { casBaseSeq?: number }) => boolean,
    private hud: (phase: 'idle'|'reading'|'planning'|'tool'|'drafting'|'waiting', label?: string, p?: number) => void,
    private planner: Planner<Cfg>,
    private cfg: Cfg,
    private ids: { myAgentId?: string; otherAgentId?: string; model?: string } = {}
  ) {}

  private planSched = false;
  // Idempotence counters
  private lastStatusPlannedSeq = 0;
  private lastInboundPlannedSeq = 0;
  private lastWhisperPlannedSeq = 0;
  private lastOutboundPlannedSeq = 0;
  private lastHead = 0;

  // Coalescing scheduler: call this often; we run at most once per microtask
  schedulePlan(): Promise<void> {
    if (this.planSched) return Promise.resolve();
    this.planSched = true;
    queueMicrotask(() => { this.planSched = false; void this.runPlanningPass(); });
    return Promise.resolve();
  }

  private async readAttachment(name: string): Promise<{ mimeType: string; bytes: string } | null> {
    const facts = this.getFacts();
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'attachment_added' && f.name === name) return { mimeType: f.mimeType, bytes: f.bytes };
    }
    return null;
  }

  async runPlanningPass() {
    const headNow = this.getHead();
    if (headNow < this.lastHead) {
      this.lastStatusPlannedSeq = 0;
      this.lastInboundPlannedSeq = 0;
      this.lastOutboundPlannedSeq = 0;
      this.lastWhisperPlannedSeq = 0;
    }
    this.lastHead = headNow;

    const facts = this.getFacts();
    if (!facts.length) return;
    const cut = { seq: headNow };

    // --- Trigger detection and guards ---
    // Latest status
    let lastStatusSeq = 0; let lastStatus: string | undefined;
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'status_changed') { lastStatusSeq = f.seq; lastStatus = (f as any).a2a; break; }
    }
    // Latest public + inbound/outbound
    let lastPublic: 'remote_received'|'remote_sent'|null = null; let lastInboundSeq = 0; let lastOutboundSeq = 0;
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'remote_received') { lastPublic = 'remote_received'; lastInboundSeq = f.seq; break; }
      if (f.type === 'remote_sent') { lastPublic = 'remote_sent'; lastOutboundSeq = f.seq; break; }
    }
    // Latest whisper
    let lastWhisperSeq = 0;
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'user_guidance') { lastWhisperSeq = f.seq; break; }
    }

    const statusTriggered = (lastStatus === 'input-required') && (lastStatusSeq > this.lastStatusPlannedSeq);
    const inboundTriggered = (lastPublic === 'remote_received') && (lastInboundSeq > this.lastInboundPlannedSeq);
    const outboundTriggered = (lastPublic === 'remote_sent') && (lastOutboundSeq > this.lastOutboundPlannedSeq);
    const whisperTriggered = lastWhisperSeq > this.lastWhisperPlannedSeq;

    // Only plan when a trigger fired
    if (!(statusTriggered || inboundTriggered || outboundTriggered || whisperTriggered)) return;
    // Status must be input-required
    if (lastStatus !== 'input-required') return;
    // Unsent compose gate (ignore dismissed): if there's a compose with no remote_sent after it, park
    const dismissed = new Set<string>(facts.filter(f=>f.type==='compose_dismissed').map((f:any)=>f.composeId));
    const hasUnsentCompose = (() => {
      for (let i = facts.length - 1; i >= 0; --i) {
        const f = facts[i];
        if (f.type === 'compose_intent') {
          const ci = f as any;
          if (dismissed.has(ci.composeId)) continue;
          for (let j = i + 1; j < facts.length; j++) { if (facts[j].type === 'remote_sent') return false; }
          return true;
        }
      }
      return false;
    })();
    if (hasUnsentCompose) return;

    const ctx: PlanContext<any> = {
      signal: undefined,
      hud: (phase, label, p) => this.hud(phase, label, p),
      newId: (prefix?: string) => rid(prefix || 'id'),
      readAttachment: (name: string) => this.readAttachment(name),
      config: this.cfg,
      myAgentId: this.ids.myAgentId,
      otherAgentId: this.ids.otherAgentId,
      model: this.ids.model,
      llm: DevNullLLM,
    };
    const input: PlanInput = { cut, facts };
    let out: ProposedFact[] = [];
    try {
      out = await this.planner.plan(input, ctx);
    } catch {
      out = [];
    }
    if (!out || !out.length) return;

    // Skip redundant sleep (prevents tight loops): do not append a single sleep if last fact is also sleep
    if (out.length === 1 && out[0]?.type === 'sleep') {
      const last = facts[facts.length - 1];
      if (last && last.type === 'sleep') {
        try { console.debug('[planner] skip redundant sleep'); } catch {}
        return;
      }
    }

    // Log planner output shape for debugging loops
    try { console.debug('[planner] result', { count: out.length, types: out.map(o => o.type) }); } catch {}
    const ok = this.append(out, { casBaseSeq: cut.seq });
    if (ok) {
      if (statusTriggered) this.lastStatusPlannedSeq = lastStatusSeq;
      if (inboundTriggered) this.lastInboundPlannedSeq = lastInboundSeq;
      if (outboundTriggered) this.lastOutboundPlannedSeq = lastOutboundSeq;
      if (whisperTriggered) this.lastWhisperPlannedSeq = lastWhisperSeq;
    }
    try { this.hud('idle'); } catch {}
  }
}

export const DevNullLLM: LlmProvider = { async chat() { return { text: "" }; } };
