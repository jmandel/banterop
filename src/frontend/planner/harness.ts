import type { Fact, ProposedFact, Planner, PlanInput, PlanContext, LlmProvider } from "../../shared/journal-types";
import { rid } from "../../shared/core";

// ---- runaway-guard (tiny inline helper) ----
const JOURNAL_HARD_CAP: number = (() => {
  try {
    const w: any = (typeof window !== 'undefined') ? (window as any).__RUNAWAY_LIMIT : undefined;
    const fromWin = (typeof w === 'number' && Number.isFinite(w)) ? w
      : (typeof w === 'string' && w.trim() !== '' && Number.isFinite(Number(w)) ? Number(w) : undefined);
    if (typeof fromWin === 'number' && fromWin > 0) return Math.floor(fromWin);
  } catch {}
  try {
    const s = (typeof window !== 'undefined') ? (window as any)?.localStorage?.getItem?.('RUNAWAY_LIMIT') : null;
    const n = (typeof s === 'string' && s.trim() !== '' && Number.isFinite(Number(s))) ? Number(s) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {}
  return 200; // default (only positive values allowed)
})();
function runawayGuardActive(len: number): boolean { return len >= JOURNAL_HARD_CAP; }

export class PlannerHarness<Cfg = unknown> {
  constructor(
    private getFacts: () => ReadonlyArray<Fact>,
    private getHead: () => number,
    private append: (batch: ProposedFact[], opts?: { casBaseSeq?: number }) => boolean,
    private hud: (phase: 'idle'|'reading'|'planning'|'tool'|'drafting'|'waiting', label?: string, p?: number) => void,
    private planner: Planner<Cfg>,
    private cfg: Cfg,
    private ids: { otherAgentId?: string; model?: string } = {},
    private llmProvider?: LlmProvider,
  ) {}

  private planSched = false;
  // Idempotence counters
  private lastStatusPlannedSeq = 0;
  private lastInboundPlannedSeq = 0;
  private lastWhisperPlannedSeq = 0;
  private lastUserAnswerPlannedSeq = 0;
  private lastOutboundPlannedSeq = 0;
  private lastHead = 0;
  

  // Coalescing scheduler: call this often; we run at most once per microtask
  schedulePlan(): Promise<void> {
    try { console.debug('[planner/harness] schedulePlan() requested; queued=%o', this.planSched); } catch {}
    if (this.planSched) return Promise.resolve();
    this.planSched = true;
    queueMicrotask(() => { this.planSched = false; void this.runPlanningPass(); });
    return Promise.resolve();
  }

  private async readAttachment(name: string): Promise<{ mimeType: string; bytes: string } | null> {
    const facts = this.getFacts();
    for (let i = 0; i < facts.length; i++) {
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
    // Bootstrap trigger: allow a single planning pass when journal is empty.
    // This avoids needing a synthetic status fact for the first proposal.
    const hasExistingTask = !!(this.ids as any)?.existingTask;
    const bootstrap = facts.length === 0 && !hasExistingTask;
    try { console.debug('[planner/harness] pass begin', { facts: facts.length, head: headNow, bootstrap }); } catch {}
    if (!bootstrap && runawayGuardActive(facts.length)) {
      try {
        const msg = `🧊 Runaway guard: planner frozen (entries=${facts.length} ≥ cap=${JOURNAL_HARD_CAP})`;
        this.hud('waiting', msg);
      } catch {}
      return;
    }
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
    // Latest whisper / user answer
    let lastWhisperSeq = 0;
    let lastUserAnswerSeq = 0;
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'user_guidance') { lastWhisperSeq = f.seq; break; }
    }
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'user_answer') { lastUserAnswerSeq = f.seq; break; }
    }
    // no agent_answer trigger; UI emits user_answer directly

    const statusTriggered = (lastStatus === 'input-required') && (lastStatusSeq > this.lastStatusPlannedSeq);
    const inboundTriggered = (lastPublic === 'remote_received') && (lastInboundSeq > this.lastInboundPlannedSeq);
    const outboundTriggered = (lastPublic === 'remote_sent') && (lastOutboundSeq > this.lastOutboundPlannedSeq);
    const whisperTriggered = lastWhisperSeq > this.lastWhisperPlannedSeq;
    const userAnswerTriggered = lastUserAnswerSeq > this.lastUserAnswerPlannedSeq;

    const dismissed = new Set<string>(facts.filter(f=>f.type==='compose_dismissed').map((f:any)=>f.composeId));
    // Only plan when a trigger fired (including bootstrap for empty journal)
    const anyTrigger = statusTriggered || inboundTriggered || outboundTriggered || whisperTriggered || userAnswerTriggered || bootstrap;
    try { console.debug('[planner/harness] triggers', { status:lastStatus||'none', lastStatusSeq, lastPublic, inboundTriggered, outboundTriggered, statusTriggered, whisperTriggered, userAnswerTriggered, bootstrap }); } catch {}
    if (!anyTrigger) return;
    // Status must be input-required, unless this is the bootstrap pass OR it's first-pass on submitted with no public traffic
    const noPublicTraffic = (lastPublic === null);
    const allowKickoffOnSubmitted = !bootstrap && noPublicTraffic && (lastStatus === 'submitted');
    if (!bootstrap && lastStatus !== 'input-required' && !allowKickoffOnSubmitted) {
      try { console.debug('[planner/harness] gate: status blocked', { status:lastStatus, allowKickoffOnSubmitted }); } catch {}
      return;
    }
    // Unsent compose gate (ignore dismissed): if there's a compose with no remote_sent after it, park
    // For normal passes, compute unsent compose gate again (dismissed set already computed)
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
    // If whisper arrived while a draft is present, dismiss the latest unsent draft now (single one), then return.
    if ((whisperTriggered || userAnswerTriggered) && hasUnsentCompose) {
      const latestUnsent = (() => {
        const dismissed2 = dismissed;
        for (let i = facts.length - 1; i >= 0; --i) {
          const f = facts[i];
          if (f.type === 'compose_intent') {
            const ci = f as any;
            if (dismissed2.has(ci.composeId)) continue;
            // ensure no remote_sent after it
            let sentAfter = false;
            for (let j = i + 1; j < facts.length; j++) { if (facts[j].type === 'remote_sent') { sentAfter = true; break; } }
            if (!sentAfter) return String(ci.composeId || '');
          }
        }
        return '';
      })();
      if (latestUnsent) {
        const ok = this.append([{ type:'compose_dismissed', composeId: latestUnsent } as any], { casBaseSeq: cut.seq });
        // Do not update whisper counters here so a subsequent pass will plan with the whisper trigger
        try { console.debug('[planner/harness] auto-dismissed latest draft due to whisper/user_answer', { composeId: latestUnsent, ok }); } catch {}
        return;
      }
      // If couldn't find the draft defensively, fall through to standard guard (which will park)
    }
    if (hasUnsentCompose) {
      try { console.debug('[planner/harness] gate: unsent compose present → park'); } catch {}
      return;
    }

    // Central open-question gate: if latest agent_question is unanswered and this trigger didn't come from user_answer/whisper or public traffic, park
    let lastQSeq = 0; let hasAnswer = false; let hasPublicAfterQ = false;
    for (let i = facts.length - 1; i >= 0; --i) { const f = facts[i] as any; if (f.type === 'agent_question') { lastQSeq = f.seq; break; } }
    if (lastQSeq) {
      for (let i = facts.length - 1; i >= 0; --i) {
        const f = facts[i] as any; if (f.seq <= lastQSeq) break;
        if (f.type === 'user_answer') { hasAnswer = true; break; }
        if (f.type === 'remote_sent' || f.type === 'remote_received') { hasPublicAfterQ = true; break; }
      }
    }
    const blockingOpenQ = lastQSeq && !hasAnswer && !whisperTriggered && !userAnswerTriggered && !inboundTriggered && !outboundTriggered && !bootstrap;
    if (blockingOpenQ) {
      try { console.debug('[planner/harness] gate: unanswered agent_question'); } catch {}
      try { this.hud('waiting', 'Awaiting answer to previous question'); } catch {}
      return;
    }

    const ctx: PlanContext<any> = {
      signal: undefined,
      hud: (phase, label, p) => this.hud(phase, label, p),
      newId: (prefix?: string) => rid(prefix || 'id'),
      readAttachment: (name: string) => this.readAttachment(name),
      config: this.cfg,
      otherAgentId: this.ids.otherAgentId,
      model: this.ids.model,
      llm: this.llmProvider || DevNullLLM,
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
      if (userAnswerTriggered) this.lastUserAnswerPlannedSeq = lastUserAnswerSeq;
    }
    try { this.hud('idle'); } catch {}
  }
}

export const DevNullLLM: LlmProvider = { async chat() { return { text: "" }; } };
