import type { Planner, PlanInput, PlanContext, ProposedFact, Fact, AttachmentMeta } from "../../../shared/journal-types";
import { LLMDrafterSetup, dehydrateLLM, hydrateLLM } from './llm-drafter.setup';
import { chatWithValidationRetry, cleanModelText } from "../../../shared/llm-retry";
import { DEFAULT_BANTEROP_MODEL } from '../../../shared/llm-provider';

type Cfg = {
  endpoint?: string;
  temperature?: number;
  systemPrompt?: string;
  systemAppend?: string;
  targetWords?: number;
};
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
    case 'message_received': {
      const who = otherId || 'other';
      const parts: string[] = [];
      parts.push(`INBOUND (${who}): ${f.text}`);
      if (Array.isArray(f.attachments)) {
        for (const a of f.attachments) parts.push(`  (attachment: ${a.name} ${a.mimeType || ''})`);
      }
      return parts.join('\n');
    }
    case 'message_sent': {
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
    case 'planner_error':
      return `PRIVATE planner_error: ${(f as any).code || 'error'}`;
    case 'sleep':
      return `SLEEP: ${f.reason || ''}`;
    // no dismissal fact for drafts (UI hides on approval)
    default:
      return null;
  }
}

function buildPrompt(input: PlanInput, ctx: PlanContext<Cfg>): { system: string; user: string } {
  const who = 'me';
  const other = ctx.otherAgentId || 'other';
  const status = latestStatus(input.facts);
  const baseSystem = (ctx.config?.systemPrompt
    || `I write the next message in a professional, turn-based exchange. I will return only the message text, in first-person singular, without code fences or JSON.`);
  const append = (ctx.config?.systemAppend || '').trim();
  const system = append ? `${baseSystem}\n\n${append}` : baseSystem;
  const lines: string[] = [];
  lines.push(`I am drafting the next message as ${who}, to ${other}.`);
  lines.push(`Current status: ${status}.`);
  lines.push('');
  lines.push('Conversation history (public, newest last):');
  for (const f of input.facts) {
    if (f.type !== 'message_received' && f.type !== 'message_sent') continue;
    const line = logLine(f, who, other);
    if (line) lines.push(line);
  }
  lines.push('');
  const tWords = Number(ctx.config?.targetWords || 0);
  if (tWords > 0) lines.push(`Aim for about ${tWords} words (±20%).`);
  lines.push('Write the next message to the other side.');
  lines.push('Output ONLY the message body.');
  const user = lines.join('\n');
  return { system, user };
}

export const LLMDrafterPlanner: Planner<Cfg> = {
  id: 'llm-drafter',
  name: 'LLM Drafter',
  // New per-planner setup API
  // @ts-ignore — Planner type allows optional methods
  SetupComponent: LLMDrafterSetup,
  // @ts-ignore — hydrate/dehydrate present for URL sync
  dehydrate: (cfg: any) => dehydrateLLM({
    systemAppend: String(cfg?.systemPrompt || cfg?.systemAppend || ''),
    targetWords: Math.max(0, Math.min(1000, Number(cfg?.targetWords || 0)))
  }),
  // @ts-ignore
  hydrate: async (seed: any) => hydrateLLM(seed),
  async plan(input, ctx) {
    ctx.hud('planning', 'LLM drafting…', 0.4);
    const p = buildPrompt(input, ctx);
    const model = ctx.model || DEFAULT_BANTEROP_MODEL;
    const temperature = typeof ctx.config?.temperature === 'number' ? ctx.config!.temperature! : DEFAULT_TEMP;
    let text: string | null = null;
    try {
      const req: { model?: string; messages: import("../../../shared/journal-types").LlmMessage[]; temperature?: number; signal?: AbortSignal } = {
        model,
        messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }],
        temperature,
        signal: ctx.signal,
      };
      text = await chatWithValidationRetry<string>(ctx.llm, req, (raw) => {
        const cleaned = cleanModelText(raw);
        if (!cleaned) throw new Error('Empty response');
        return cleaned;
      }, { attempts: 3 });
    } catch {
      text = null;
    }
    if (!text) {
      ctx.hud('waiting', 'LLM empty/error');
      const err: ProposedFact = ({ type:'planner_error', code:'LLM_EMPTY', message:'LLM returned empty/error while drafting', stage:'drafter', attempts:3, announce:true }) as any;
      const msg: ProposedFact = ({ type:'compose_intent', composeId: ctx.newId('c'), text: 'We encountered a drafting error and could not proceed. Please respond so we can continue.', nextStateHint: 'working' } as ProposedFact);
      return [err, msg];
    }
    ctx.hud('drafting', `Draft ${text.length} chars`);
    return [{ type:'compose_intent', composeId: ctx.newId('c'), text } as ProposedFact];
  },

  // Planning logic unchanged
};
