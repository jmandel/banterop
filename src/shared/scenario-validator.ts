import type { ScenarioConfiguration } from '../types/scenario-configuration.types';

export function validateScenarioConfig(obj: unknown): { ok: true; value: ScenarioConfiguration } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  function err(s: string) { if (errors.length < 10) errors.push(s); }
  const isStr = (v: any) => typeof v === 'string' && v.trim().length > 0;

  const root = (obj as any)?.config ?? obj;
  if (!root || typeof root !== 'object') return { ok: false, errors: ['Root must be an object'] };
  const md = root.metadata;
  if (!md || typeof md !== 'object') err('metadata missing or not an object');
  else {
    if (!isStr(md.id)) err('metadata.id must be a non-empty string');
    if (!isStr(md.title)) err('metadata.title must be a non-empty string');
    if (!isStr(md.description)) err('metadata.description must be a non-empty string');
  }

  const agents = Array.isArray(root.agents) ? root.agents : [];
  if (!Array.isArray(root.agents) || agents.length === 0) err('agents must be a non-empty array');
  for (let i = 0; i < agents.length && errors.length < 10; i++) {
    const a = agents[i];
    if (!isStr(a?.agentId)) err(`agents[${i}].agentId must be a non-empty string`);
    const p = a?.principal;
    if (!p || typeof p !== 'object') err(`agents[${i}].principal missing`);
    else {
      if (!isStr(p.name)) err(`agents[${i}].principal.name must be a non-empty string`);
      if (!isStr(p.description)) err(`agents[${i}].principal.description must be a non-empty string`);
      if (p.type !== 'individual' && p.type !== 'organization') err(`agents[${i}].principal.type must be 'individual'|'organization'`);
    }
    if (!isStr(a?.systemPrompt)) err(`agents[${i}].systemPrompt must be a non-empty string`);
    if (!Array.isArray(a?.goals) || a.goals.length === 0 || !a.goals.every(isStr)) err(`agents[${i}].goals must be a non-empty string[]`);
    if (!Array.isArray(a?.tools)) err(`agents[${i}].tools must be an array`);
    else {
      for (let j = 0; j < a.tools.length && errors.length < 10; j++) {
        const t = a.tools[j];
        if (!isStr(t?.toolName)) err(`agents[${i}].tools[${j}].toolName must be a non-empty string`);
        if (!isStr(t?.description)) err(`agents[${i}].tools[${j}].description must be a non-empty string`);
        const sch = t?.inputSchema;
        if (!sch || typeof sch !== 'object') err(`agents[${i}].tools[${j}].inputSchema missing`);
        else if (sch.type !== 'object') err(`agents[${i}].tools[${j}].inputSchema.type must be 'object'`);
        if (t?.endsConversation != null && typeof t.endsConversation !== 'boolean') err(`agents[${i}].tools[${j}].endsConversation must be boolean if present`);
        if (t?.conversationEndStatus != null && !['success','failure','neutral'].includes(t.conversationEndStatus)) err(`agents[${i}].tools[${j}].conversationEndStatus must be success|failure|neutral if present`);
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: root as ScenarioConfiguration };
}

