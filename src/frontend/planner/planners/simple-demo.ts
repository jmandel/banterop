import type { Planner, PlanInput, PlanContext, ProposedFact, AttachmentMeta } from "../../../shared/journal-types";

function lastRemoteReceived(input: PlanInput): { text:string; attachments?:AttachmentMeta[] } | null {
  for (let i = input.facts.length - 1; i >= 0; --i) {
    const f = input.facts[i];
    if (f.type === 'remote_received') return { text: f.text, attachments: f.attachments };
  }
  return null;
}

function hasUnsentCompose(input:PlanInput): boolean {
  // If there is a compose_intent that hasn't resulted in any remote_sent AFTER it
  for (let i = input.facts.length - 1; i >= 0; --i) {
    const f = input.facts[i];
    if (f.type === 'compose_intent') {
      const composeSeq = f.seq;
      for (let j = i + 1; j < input.facts.length; j++) {
        const g = input.facts[j];
        if (g.type === 'remote_sent') return false; // remote_sent after compose → not unsent
      }
      return true; // no remote_sent after compose
    }
  }
  return false;
}

export const SimpleDemoPlanner: Planner<{ mode:'off'|'suggest'|'auto' }> = {
  id: "simple-demo",
  name: "Simple Demo Planner",
  async plan(input, ctx) {
    const mode = (ctx.config?.mode || 'suggest') as 'off'|'suggest'|'auto';
    if (mode === 'off') return [];
    ctx.hud('reading', 'Scanning latest message…', 0.2);

    // Only act when it's our turn (task requires input)
    const lastStatus = (() => {
      for (let i = input.facts.length - 1; i >= 0; --i) {
        const f = input.facts[i];
        if (f.type === 'status_changed') return f.a2a as string;
      }
      return 'unknown';
    })();
    if (lastStatus !== 'input-required') {
      ctx.hud('waiting', 'Not our turn');
      return [{ type:'sleep', reason:'Not our turn' }];
    }

    // If a compose is already open and unsent, sleep
    if (hasUnsentCompose(input)) { ctx.hud('waiting', 'Draft open'); return [{ type:'sleep', reason:'Draft open' }]; }

    // Only respond if the latest public message is from the other side
    const lastPublic = (() => {
      for (let i = input.facts.length - 1; i >= 0; --i) {
        const f = input.facts[i];
        if (f.type === 'remote_received' || f.type === 'remote_sent') return f.type;
      }
      return null as ("remote_received" | "remote_sent" | null);
    })();
    if (lastPublic === 'remote_sent') {
      ctx.hud('waiting', 'Already responded');
      return [{ type:'sleep', reason:'Already responded' }];
    }

    const rr = lastRemoteReceived(input);
    if (!rr) { ctx.hud('waiting', 'No inbound yet'); return [{ type:'sleep', reason:'Awaiting inbound' }]; }

    const t = rr.text.toLowerCase();
    // Branch: Ask availability for peer-to-peer
    if (t.includes('peer-to-peer') || t.includes('peer to peer') || t.includes('callback availability')) {
      ctx.hud('planning', 'Need user availability');
      const qid = ctx.newId('q');
      return [{
        type:'agent_question', qid, prompt:'What time windows work for a peer-to-peer call?', required:true, placeholder:'e.g., Thu 2–4pm CT',
        why:'Payer asked for P2P scheduling'
      }];
    }

    // Branch: prior auth request → propose compose with synthesized notes
    if (t.includes('prior auth') || t.includes('prior authorization') || t.includes('cpt')) {
      ctx.hud('tool', 'Fetching chart notes', 0.3);
      const callId = ctx.newId('tool:ehr');
      const attName = 'clinical_notes.txt';
      const facts: ProposedFact[] = [
        ({ type:'tool_call', callId, name:'fetchChart', args:{ patientId:'PAT-009', lastDays:90 }, why:'Fetch chart notes for failed therapy' }) as ProposedFact,
        ({ type:'tool_result', callId, ok:true, why:'EHR returned last 90d visits' }) as ProposedFact,
        ({ type:'attachment_added', origin:'synthesized', name:attName, mimeType:'text/plain', bytes:btoa('HPI: 6 weeks knee pain, PT failed, +McMurray. Plan: MRI knee CPT 73721.'), producedBy:{ callId, name:'fetchChart', args:{ patientId:'PAT-009' } }, why:'Summarized chart for payer' }) as ProposedFact,
        ({ type:'compose_intent', composeId: ctx.newId('c'), text:
`To: Payer PA Team
Subject: Prior Authorization – MRI knee (CPT 73721)
Ref: PA-123

Patient reports 6 weeks of right knee pain unresponsive to NSAIDs + PT. Positive McMurray; limited ROM.
Clinical notes attached. Requesting MRI knee per guideline after failed conservative therapy.`,
          attachments: [{ name: attName, mimeType:'text/plain' }], why:'Meets criteria; add notes'
        }) as ProposedFact
      ];
      return facts;
    }

    // Default: propose a short acknowledgement
    ctx.hud('drafting', 'Composing acknowledgement', 0.6);
    return [{
      type:'compose_intent', composeId: ctx.newId('c'), text:'Acknowledged. We are reviewing and will respond shortly.',
      why:'Fallback acknowledgement'
    }];
  }
};
