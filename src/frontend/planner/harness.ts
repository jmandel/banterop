// copied from src-with-planner/frontend/planner/harness.ts
// Keeping as-is; not yet wired into UI by default
import type { Planner, PlanInput, ProposedFact, Fact, AttachmentMeta } from '../../shared/journal-types';

export class PlannerHarness<Cfg=unknown> {
  constructor(private opts: {
    planner: Planner<Cfg>;
    readAttachment: (name:string) => Promise<{ mimeType:string; bytes:string } | null>;
    hud?: (phase:string, label?:string, p?:number) => void;
    newId: (prefix?:string)=>string;
    getFacts: ()=>ReadonlyArray<Fact>;
    applyFacts: (facts: ProposedFact[])=>void;
    getCut: ()=>{ seq:number };
  }) {}

  async kick(signal?: AbortSignal) {
    const hud = this.opts.hud || (()=>{});
    const input: PlanInput = { cut: this.opts.getCut(), facts: this.opts.getFacts() };
    const ctx = {
      signal,
      hud: (p:string,l?:string,pp?:number)=>hud(p,l,pp),
      newId: this.opts.newId,
      readAttachment: this.opts.readAttachment,
      llm: { chat: async () => ({ text: '' }) }
    } as any;
    const out = await this.opts.planner.plan(input, ctx);
    if (Array.isArray(out) && out.length) this.opts.applyFacts(out);
  }
}

