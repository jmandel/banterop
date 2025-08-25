import type { Planner, PlanInput, PlanContext, ProposedFact, Fact, AttachmentMeta } from "../../../shared/journal-types";

type Cfg = {
  endpoint?: string;
  model?: string;
  temperature?: number;
  systemPrompt?: string;
};

const DEFAULT_ENDPOINT = "https://chitchat.fhir.me/api/llm/complete";
const DEFAULT_MODEL = "openai/gpt-oss-120b:nitro";
const DEFAULT_TEMP = 0.2;

function latestStatus(facts: ReadonlyArray<Fact>): string {
  for (let i = facts.length - 1; i >= 0; --i) {
    const f = facts[i];
    if (f.type === 'status_changed') return f.a2a;
  }
  return 'unknown';
}

function logLine(f: Fact, myId?: string, otherId?: string): string | null {
  switch (f.type) {
    case 'remote_received': {
      const who = otherId || 'other';
      const parts: string[] = [];
      parts.push(`INBOUND (${who}): ${f.text}`);
      if (Array.isArray(f.attachments)) {
        for (const a of f.attachments) parts.push(`  (attachment: ${a.name} ${a.mimeType || ''})`);
      }
      return parts.join('\n');
    }
    case 'remote_sent': {
      const who = myId || 'me';
      const parts: string[] = [];
      parts.push(`OUTBOUND (${who}): ${f.text}`);
      if (Array.isArray(f.attachments)) {
        for (const a of f.attachments) parts.push(`  (attachment: ${a.name} ${a.mimeType || ''})`);
      }
      return parts.join('\n');
    }
    case 'user_guidance':
      return `PRIVATE whisper: ${f.text}`;
    case 'agent_question':
      return `PRIVATE question: ${f.prompt}`;
    case 'agent_answer':
      return `PRIVATE answer: ${f.text}`;
    case 'compose_intent':
      return `PRIVATE draft: ${f.text}`;
    case 'attachment_added':
      return `PRIVATE attachment: ${f.name} ${f.mimeType} origin=${f.origin}`;
    case 'status_changed':
      return `STATUS: ${f.a2a}`;
    case 'tool_call':
      return `PRIVATE tool_call: ${f.name}`;
    case 'tool_result':
      return `PRIVATE tool_result: ${f.ok ? 'ok' : 'error'}`;
    case 'sleep':
      return `SLEEP: ${f.reason || ''}`;
    case 'compose_dismissed':
      return `PRIVATE draft-dismissed: ${f.composeId}`;
    default:
      return null;
  }
}

function buildPrompt(input: PlanInput, ctx: PlanContext<Cfg>): { system: string; user: string } {
  const who = ctx.myAgentId || 'me';
  const other = ctx.otherAgentId || 'other';
  const status = latestStatus(input.facts);
  const system = (ctx.config?.systemPrompt
    || `I write the next message in a professional, turn-based exchange. I will return only the message text, in first-person singular, without code fences or JSON.`);
  const lines: string[] = [];
  lines.push(`I am drafting the next message as ${who}, to ${other}.`);
  lines.push(`Current status: ${status}.`);
  lines.push('');
  lines.push('Conversation history (newest last):');
  for (const f of input.facts) {
    const line = logLine(f, who, other);
    if (line) lines.push(line);
  }
  lines.push('');
  lines.push('Write the next message to the other side.');
  lines.push('Output ONLY the message body.');
  const user = lines.join('\n');
  return { system, user };
}

async function callLLM(prompt: { system: string; user: string }, cfg: Cfg, signal?: AbortSignal): Promise<string | null> {
  try {
    const endpoint = cfg.endpoint || DEFAULT_ENDPOINT;
    const model = cfg.model || DEFAULT_MODEL;
    const temperature = typeof cfg.temperature === 'number' ? cfg.temperature : DEFAULT_TEMP;
    const body = JSON.stringify({ messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], model, temperature });
    const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal });
    if (!res.ok) return null;
    const j: any = await res.json();
    const text =
      (j && typeof j === 'object' && j.result && typeof j.result.text === 'string' && j.result.text)
      || (j && Array.isArray(j.choices) && j.choices[0]?.message?.content)
      || (typeof j.text === 'string' ? j.text : null);
    if (!text) return null;
    const cleaned = String(text).trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
    return cleaned || null;
  } catch {
    return null;
  }
}

export const LLMDrafterPlanner: Planner<Cfg> = {
  id: 'llm-drafter',
  name: 'LLM Drafter',
  async plan(input, ctx) {
    ctx.hud('planning', 'LLM drafting…', 0.4);
    const p = buildPrompt(input, ctx);
    const text = await callLLM(p, ctx.config || {}, ctx.signal);
    if (!text) {
      ctx.hud('waiting', 'LLM empty/error');
      return [{ type:'sleep', reason:'LLM empty/error' } as ProposedFact];
    }
    ctx.hud('drafting', `Draft ${text.length} chars`);
    return [{ type:'compose_intent', composeId: ctx.newId('c'), text } as ProposedFact];
  },
};
