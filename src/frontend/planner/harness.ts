import type { Fact, ProposedFact, TerminalFact, Cut, Planner, PlanInput, PlanContext, LlmProvider, AttachmentMeta } from "../../shared/journal-types";
import type { FrameResult } from "../transports/a2a-client";
import type { A2APart } from "../../shared/a2a-types";

export type HudEvent = { ts:string; phase:'idle'|'reading'|'planning'|'tool'|'drafting'|'waiting'; label?:string; p?:number };

function nowIso() { return new Date().toISOString(); }
function rid(prefix?:string) { return `${prefix||'id'}-${crypto.randomUUID()}`; }

export class Journal {
  private _facts: Fact[] = [];
  private _seq = 0;
  private listeners = new Set<() => void>();

  head(): Cut { return { seq: this._seq }; }
  facts(): ReadonlyArray<Fact> { return this._facts; }

  onAnyNewEvent(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private notify() { this.listeners.forEach(fn => { try { fn(); } catch {} }); }

  /** Append a single already-stamped fact; used internally. */
  private _pushStamped(f: Fact) { this._facts.push(f); this._seq = f.seq; this.notify(); }

  /** Clear all facts (local UI state reset). */
  clear() { this._facts = []; this._seq = 0; this.notify(); }

  /** Append a fact authored by harness/UI (auto-stamped). */
  append(f: ProposedFact, vis:'public'|'private'): Fact {
    const stamped = Object.assign({}, f, { seq: this._seq + 1, ts: nowIso(), id: rid('f'), vis }) as unknown as Fact;
    this._pushStamped(stamped);
    return stamped;
  }

  /** Append a batch under seq-only CAS. */
  casAppend(baseSeq: number, batch: ProposedFact[], visResolver:(f:ProposedFact)=>'public'|'private'): boolean {
    if (this._seq !== baseSeq) return FalseLike();
    const nextSeqStart = this._seq + 1;
    const stamped = batch.map((f, i) => Object.assign({}, f, { seq: nextSeqStart + i, ts: nowIso(), id: rid('f'), vis: visResolver(f) })) as unknown as Fact[];
    for (const s of stamped) this._pushStamped(s);
    return true;
  }
}

function FalseLike(): false { return false; }

// Type guards for ProposedFact variants used below
type PF<K extends ProposedFact['type']> = Extract<ProposedFact, { type: K }>;
function isToolResult(f: ProposedFact): f is PF<'tool_result'> { return f.type === 'tool_result'; }
function isAttachmentAdded(f: ProposedFact): f is PF<'attachment_added'> { return f.type === 'attachment_added'; }
function isComposeIntent(f: ProposedFact): f is PF<'compose_intent'> { return f.type === 'compose_intent'; }
function isRemotePublic(f: ProposedFact): f is PF<'remote_received'> | PF<'remote_sent'> { return f.type === 'remote_received' || f.type === 'remote_sent'; }

// --- Validation (brief 4 & 10) ---
export function validateBatch(batch: ProposedFact[], history: ReadonlyArray<Fact>): boolean {
  if (batch.length) {
    const t = batch[batch.length - 1].type;
    if (t !== 'compose_intent' && t !== 'agent_question' && t !== 'sleep') return false;
  }
  for (const f of batch) {
    if (f.type === 'agent_answer' || f.type === 'remote_sent') return false;
  }
  // Tool result linkage
  const ok = new Set<string>();
  for (const f of batch) {
    if (f.type === 'tool_result') {
      const tr = f as unknown as { type:'tool_result'; callId:string; ok:boolean };
      if (tr.ok) ok.add(tr.callId);
    }
  }
  const existsEarlierOk = (id: string) => history.some(x => x.type === 'tool_result' && x.callId === id && x.ok);
  for (const f of batch) {
    if (f.type === 'attachment_added' && (f as unknown as { origin:'inbound'|'user'|'synthesized' }).origin === 'synthesized') {
      const aa = f as unknown as { producedBy?: { callId: string } };
      const call = aa.producedBy?.callId;
      if (!call) return false;
      if (!(ok.has(call) || existsEarlierOk(call))) return false;
    }
  }
  // compose attachments resolvable
  const introduced = new Set<string>();
  for (const f of batch) if (f.type === 'attachment_added') introduced.add((f as unknown as { name:string }).name);
  const known = new Set(history.filter(x => x.type === 'attachment_added').map(x => x.name));
  for (const f of batch) if (f.type === 'compose_intent' && (f as unknown as { attachments?: AttachmentMeta[] }).attachments) {
    const ci = f as unknown as { attachments?: AttachmentMeta[] };
    for (const a of ci.attachments || []) if (!known.has(a.name) && !introduced.has(a.name)) return false;
  }
  return true;
}

// --- Harness ---
export type HarnessCallbacks = {
  onHud?: (ev: HudEvent) => void;
  onHudFlush?: (evs: HudEvent[]) => void;
  onComposerOpened?: (compose: { composeId:string; text:string; attachments?:AttachmentMeta[] }) => void;
  onComposerCleared?: () => void;
  onQuestion?: (q:{ qid:string; prompt:string; required?:boolean; placeholder?:string }) => void;
};

export type SendMessageFn = (parts: A2APart[], opts:{ messageId:string; signal?:AbortSignal }) => AsyncGenerator<FrameResult>;

export class PlannerHarness<Cfg=unknown> {
  constructor(
    private journal: Journal,
    private planner: Planner<Cfg>,
    private sendMessage: SendMessageFn,
    private cfg: Cfg,
    private ids: { myAgentId: string; otherAgentId: string; model?: string },
    private cbs: HarnessCallbacks = {}
  ) {}

  private hudLog: HudEvent[] = [];
  private composing: { composeId:string; text:string; attachments?:AttachmentMeta[] } | null = null;
  private awaitingAnswerForQid: string | null = null;
  private pendingSent: { messageId:string; text:string; attachments?:AttachmentMeta[]; composeId?:string } | null = null;

  /** Reset local transient state (composing, questions, pending). */
  resetLocal() {
    this.composing = null;
    this.awaitingAnswerForQid = null;
    this.pendingSent = null;
    this.flushHud();
  }

  // --- UI helpers ---
  openComposer(ci:{ composeId:string; text:string; attachments?:AttachmentMeta[] }) {
    this.composing = ci;
    if (this.cbs.onComposerOpened) this.cbs.onComposerOpened(ci);
  }
  clearComposer() {
    this.composing = null;
    if (this.cbs.onComposerCleared) this.cbs.onComposerCleared();
  }
  getComposer() { return this.composing; }

  hud(phase:HudEvent['phase'], label?:string, p?:number) {
    const ev: HudEvent = { ts: nowIso(), phase, label, p };
    this.hudLog.push(ev);
    if (this.cbs.onHud) this.cbs.onHud(ev);
  }
  flushHud() {
    if (this.cbs.onHudFlush && this.hudLog.length) this.cbs.onHudFlush(this.hudLog.slice());
    this.hudLog = [];
  }

  /** Append an explicit user whisper/guidance. */
  addUserGuidance(text:string) {
    const gid = rid('g');
    this.journal.append({ type:'user_guidance', gid, text } as ProposedFact, 'private');
    // Any new event should wake planner
    this.kick();
  }

  /** Answer an agent question; commits and wakes planner. */
  answerQuestion(qid:string, text:string) {
    this.awaitingAnswerForQid = null;
    this.journal.append({ type:'agent_answer', qid, text } as ProposedFact, 'private');
    this.kick();
  }

  /** Map A2A frames into journal facts. */
  ingestA2AFrame(frame: FrameResult) {
    if (!frame) return;
    if ('kind' in frame) {
      if (frame.kind === 'task') {
        const st = frame.status?.state || 'submitted';
        this.journal.append({ type: 'status_changed', a2a: st } as ProposedFact, 'private');
        const m = frame.status?.message;
        if (m && m.role === 'agent') {
          const textParts = (m.parts || []).filter((p): p is Extract<A2APart, { kind: 'text' }> => p.kind === 'text').map(p => p.text).join('\n');
          const messageId = m.messageId || rid('m');
          // Avoid duplicates: if already recorded, skip
          const already = this.journal.facts().some(ff => ff.type === 'remote_received' && ff.messageId === messageId);
          if (!already) {
            const attachments: AttachmentMeta[] = [];
            for (const p of (m.parts || [])) {
              if (p.kind === 'file' && 'bytes' in p.file && typeof p.file.bytes === 'string') {
                const name = p.file.name || `${p.file.mimeType || 'application/octet-stream'}-${Math.random().toString(36).slice(2, 7)}.bin`;
                this.journal.append({ type: 'attachment_added', name, mimeType: p.file.mimeType || 'application/octet-stream', bytes: p.file.bytes, origin: 'inbound' } as ProposedFact, 'private');
                attachments.push({ name, mimeType: p.file.mimeType || 'application/octet-stream', origin: 'inbound' });
              }
            }
            this.journal.append({ type: 'remote_received', messageId, text: textParts, attachments: attachments.length ? attachments : undefined } as ProposedFact, 'public');
          }
        }
        // If the latest message was authored by us (role='user') and matches pendingSent, record remote_sent
        if (m && m.role === 'user' && this.pendingSent) {
          const textParts = (m.parts || []).filter((p): p is Extract<A2APart, { kind: 'text' }> => p.kind === 'text').map(p => p.text).join('\n');
          const messageId = m.messageId || rid('m');
          if (this.pendingSent.messageId === messageId) {
            this.journal.append({ type: 'remote_sent', messageId, text: (this.pendingSent.text || textParts), attachments: this.pendingSent.attachments, composeId: this.pendingSent.composeId } as ProposedFact, 'public');
            this.pendingSent = null;
            this.clearComposer();
          }
        }
        return;
      }
      if (frame.kind === 'status-update') {
        const st = frame.status?.state || 'submitted';
        this.journal.append({ type: 'status_changed', a2a: st } as ProposedFact, 'private');
        const m = frame.status?.message;
        if (m && m.role === 'user') {
          const textParts = (m.parts || []).filter((p): p is Extract<A2APart, { kind: 'text' }> => p.kind === 'text').map(p => p.text).join('\n');
          const messageId = m.messageId || rid('m');
          if (this.pendingSent && this.pendingSent.messageId === messageId) {
            this.journal.append({ type: 'remote_sent', messageId, text: (this.pendingSent.text || textParts), attachments: this.pendingSent.attachments, composeId: this.pendingSent.composeId } as ProposedFact, 'public');
            this.pendingSent = null;
            this.clearComposer();
          }
        }
        return;
      }
      if (frame.kind === 'message') {
        const textParts = (frame.parts || []).filter((p): p is Extract<A2APart, { kind: 'text' }> => p.kind === 'text').map(p => p.text).join('\n');
        const messageId = frame.messageId || rid('m');
        const attachments: AttachmentMeta[] = [];
        const parts = (frame.parts || []);
        for (const p of parts) {
          if (p.kind === 'file' && 'bytes' in p.file && typeof p.file.bytes === 'string') {
            const name = p.file.name || `${p.file.mimeType || 'application/octet-stream'}-${Math.random().toString(36).slice(2, 7)}.bin`;
            this.journal.append({ type: 'attachment_added', name, mimeType: p.file.mimeType || 'application/octet-stream', bytes: p.file.bytes, origin: 'inbound' } as ProposedFact, 'private');
            attachments.push({ name, mimeType: p.file.mimeType || 'application/octet-stream', origin: 'inbound' });
          }
        }
        this.journal.append({ type: 'remote_received', messageId, text: textParts, attachments: attachments.length ? attachments : undefined } as ProposedFact, 'public');
        return;
      }
    }
  }

  /** Approve & send a compose intent (will be ignored if not our turn). */
  async approveAndSend(composeId: string, finality:'none'|'turn'|'conversation'='turn') {
    console.debug('[harness] approveAndSend start', { composeId, finality });
    const facts = this.journal.facts();
    const ci = [...facts].reverse().find((f): f is Extract<Fact, { type: 'compose_intent' }> => f.type === 'compose_intent' && f.composeId === composeId);
    if (!ci) return;
    // Build A2A parts
    const parts: A2APart[] = [];
    const textPart: Extract<A2APart, { kind: 'text' }> = { kind: 'text', text: ci.text, metadata: { 'https://chitchat.fhir.me/a2a-ext': { finality } } };
    parts.push(textPart);
    if (Array.isArray(ci.attachments)) {
      for (const a of ci.attachments) {
        const resolved = await this.readAttachment(a.name);
        if (resolved) {
          const filePart: Extract<A2APart, { kind: 'file' }> = { kind: 'file', file: { bytes: resolved.bytes, name: a.name, mimeType: resolved.mimeType } };
          parts.push(filePart);
        }
      }
    }
    // Send via A2A; append remote_sent when the status-update reflecting this message arrives.
    const messageId = rid('m');
    this.pendingSent = { messageId, text: ci.text, attachments: ci.attachments, composeId };
    for await (const frame of this.sendMessage(parts, { messageId })) {
      this.ingestA2AFrame(frame);
    }
    console.debug('[harness] approveAndSend done', { composeId });
  }

  /** Read attachment bytes by name at current cut. */
  async readAttachment(name:string): Promise<{ mimeType:string; bytes:string } | null> {
    const facts = this.journal.facts();
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'attachment_added' && f.name === name) return { mimeType: f.mimeType, bytes: f.bytes };
    }
    return null;
  }

  /** Kick one planning pass if there are no outstanding questions. */
  async kick() {
    // Outstanding question gate
    const facts = this.journal.facts();
    const openQ = [...facts].reverse().find((f): f is Extract<Fact, { type: 'agent_question' }> => f.type === 'agent_question' && !facts.some(g => g.type === 'agent_answer' && g.qid === f.qid));
    if (openQ) {
      this.awaitingAnswerForQid = openQ.qid;
      if (this.cbs.onQuestion) this.cbs.onQuestion({ qid: openQ.qid, prompt: openQ.prompt, required: openQ.required, placeholder: openQ.placeholder });
      return;
    }
    // Prepare a cut
    const cut = this.journal.head();
    const controller = new AbortController();
    const unsub = this.journal.onAnyNewEvent(() => controller.abort());
    const ctx: PlanContext<any> = {
      signal: controller.signal,
      hud: (phase: HudEvent['phase'], label?: string, p?: number) => this.hud(phase, label, p),
      newId: (prefix?:string) => rid(prefix),
      readAttachment: (name: string) => this.readAttachment(name),
      config: this.cfg,
      myAgentId: this.ids.myAgentId,
      otherAgentId: this.ids.otherAgentId,
      model: this.ids.model,
      llm: DevNullLLM,
    };
    const input: PlanInput = { cut, facts: this.journal.facts() };
    let out: ProposedFact[] = [];
    try {
      out = await this.planner.plan(input, ctx);
    } finally {
      unsub();
      this.flushHud();
    }
    if (!out || !out.length) return;
    if (!validateBatch(out, this.journal.facts())) return;

    const visResolver = (f:ProposedFact) => (f.type === 'remote_received' || f.type === 'remote_sent') ? 'public' : 'private';
    if (!this.journal.casAppend(cut.seq, out, visResolver)) {
      // Head moved → planner will be kicked again by the very event that moved the head.
      return;
    }
    // Materialize only after commit
    const last = out[out.length - 1];
    if (last.type === 'compose_intent') {
      const ci = last as unknown as { composeId: string; text: string; attachments?: AttachmentMeta[] };
      this.openComposer({ composeId: ci.composeId, text: ci.text, attachments: ci.attachments });
    }
    if (last.type === 'agent_question' && this.cbs.onQuestion) {
      const aq = last as unknown as { qid: string; prompt: string; required?: boolean; placeholder?: string };
      this.cbs.onQuestion({ qid: aq.qid, prompt: aq.prompt, required: aq.required, placeholder: aq.placeholder });
    }
    // sleep → do nothing
  }
}

// Simple LLM provider placeholder
export const DevNullLLM: LlmProvider = {
  async chat() { return { text: "" }; }
};
