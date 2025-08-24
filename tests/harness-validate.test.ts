import { validateBatch } from "../src/frontend/planner/harness";
import type { ProposedFact, Fact } from "../src/shared/journal-types";

test("rejects non-terminal last", () => {
  const hist: Fact[] = [];
  const bad: ProposedFact[] = [{ type:'user_guidance', gid:'g1', text:'x' } as any];
  expect(validateBatch(bad, hist)).toBe(false);
});

test("rejects agent_answer / remote_sent in proposed", () => {
  const hist: Fact[] = [];
  expect(validateBatch([{ type:'agent_answer', qid:'q', text:'x' } as any], hist)).toBe(false);
  expect(validateBatch([{ type:'remote_sent', messageId:'m', text:'x' } as any], hist)).toBe(false);
});

test("accepts compose with introduced attachment", () => {
  const hist: Fact[] = [];
  const batch: ProposedFact[] = [
    { type:'attachment_added', name:'a.txt', mimeType:'text/plain', bytes:btoa('hi'), origin:'synthesized', producedBy:{ callId:'c1', name:'t', args:{} } } as any,
    { type:'tool_call', callId:'c1', name:'t', args:{} } as any,
    { type:'tool_result', callId:'c1', ok:true } as any,
    { type:'compose_intent', composeId:'c-1', text:'hello', attachments:[{ name:'a.txt', mimeType:'text/plain' }] } as any
  ];
  expect(validateBatch(batch, hist)).toBe(true);
});
