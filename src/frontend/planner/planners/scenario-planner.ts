// src/frontend/planner/planners/scenario-planner.ts
//
// Scenario-aware planner for v0.3 Planner API.
// NOTES
// - This file is self-contained except for imports of your v0.3 types and the ScenarioConfiguration types.
// - No adapters; returns ProposedFacts[] directly per v0.3.
// - Your harness should:
//   * enforce CAS + validations
//   * open composer on compose_intent
//   * send only when A2A status is 'input-required'
//   * (optionally) set finality='conversation' when it detects a terminal-tool-led compose (based on 'why' or policy)

import type {
  Planner, PlanInput, PlanContext, ProposedFact, LlmMessage,
  Fact, AttachmentMeta
} from '../../../shared/journal-types'; // ← adjust path if needed
import { chatWithValidationRetry } from '../../../shared/llm-retry';
import { b64ToUtf8 } from '../../../shared/codec';
import type { ScenarioConfiguration, Tool as ScenarioTool } from '../../../types/scenario-configuration.types'; // ← adjust

// ---------------------u--------
// Public export
// -----------------------------

export interface ScenarioPlannerConfig {
  scenario: ScenarioConfiguration;  // Pure scenario object
  scenarioUrl: string;              // URL stored separately (no monkeypatch)
  /** Optional model override; otherwise ctx.model is used. */
  model?: string;
  /** Optional list of tool names to enforce; if omitted, all tools enabled. */
  enabledTools?: string[];
  /** Which agent we are playing as (agentId). Defaults to first agent. */
  myAgentId?: string;
  /** Core tools allow-list (send/read/sleep/done/principal). Omit → all enabled. */
  enabledCoreTools?: string[];
  /** Max planner steps within one pass (reserved; defaults handled by planner). */
  maxInlineSteps?: number;
}

export const ScenarioPlannerV03: Planner<ScenarioPlannerConfig> = {
  id: 'scenario-v0.3',
  name: 'Scenario Planner (v0.3)',

  // Config management - use the clean VM adapter
  createConfigStore: (opts) => {
    const { makeConfigStore } = require('../../setup-vm/makeConfigStore');
    const { createScenarioSetupVM } = require('./scenario-setup-vm');
    return makeConfigStore(createScenarioSetupVM(), opts);
  },

  async plan(input: PlanInput, ctx: PlanContext<ScenarioPlannerConfig>): Promise<ProposedFact[]> {
    const { facts } = input;
    const cfg = ctx.config || ({} as ScenarioPlannerConfig);
    const includeWhy = true;

    // --- HUD: planning lifecycle
    try { ctx.hud('planning', 'Thinking…', 0.1); } catch {}

    // 0) Gate on unanswered agent_question (harness likely gates too, but be safe)
    const openQ = findOpenQuestion(facts);
    if (openQ) {
      return [sleepFact(`Waiting on user's answer to ${openQ.qid}`, includeWhy)];
    }

    // 1) Read current status pill
    const status = getLastStatus(facts) || 'initializing';

    // 2) Hold during 'working' (no tools/no nudges)
    if (status === 'working' || status === 'submitted' || status === 'initializing') {
      return [sleepFact(`Counterpart working or not ready (status=${status})`, includeWhy)];
    }

    // 3) Allow one wrap-up after 'completed'
    if (status === 'completed') {
      if (!hasAskedWrapUp(facts)) {
        const qid = ctx.newId('wrapup:');
        const q: ProposedFact = ({
          type: 'agent_question',
          qid,
          prompt: `Add any final note for your records? (optional)`,
          required: false,
          placeholder: 'Optional: e.g., “Patient asked to share findings with PT.”',
          ...(includeWhy ? { why: 'Conversation completed; offering a one-time wrap-up note.' } : {})
        }) as ProposedFact;
        return [q];
      }
      return [sleepFact('Completed; nothing left to do.', includeWhy)];
    }

    // Past this point: status is typically 'input-required' or 'canceled'/'failed'
    if (status === 'failed' || status === 'canceled') {
      return [sleepFact(`No actions: status=${status}`, includeWhy)];
    }

    // 4) Multi-step loop with single-batch output
    try { ctx.hud('reading', 'Preparing prompt', 0.2); } catch {}
    const scenario = cfg.scenario;
    const myId = cfg.myAgentId || scenario?.agents?.[0]?.agentId || 'planner';
    const counterpartId = (scenario?.agents?.find(a => a.agentId !== myId)?.agentId) || (scenario?.agents?.[1]?.agentId) || 'counterpart';
    const allowSendToRemote = status === 'input-required';
    const enabledScenarioTools = Array.isArray((ctx.config as any)?.enabledTools) ? (ctx.config as any).enabledTools as string[] : undefined;
    const coreAllowed = new Set<string>(Array.isArray(cfg.enabledCoreTools) && cfg.enabledCoreTools.length ? cfg.enabledCoreTools : ['sendMessageToRemoteAgent','sendMessageToMyPrincipal','readAttachment','sleep','done']);
    const model = cfg.model || ctx.model;
    const maxSteps = Math.max(1, Math.min(50, Number(cfg.maxInlineSteps ?? 20)));

    const out: ProposedFact[] = [];
    const workingFacts: any[] = [...facts];
    const sys: LlmMessage = { role: 'system', content: SYSTEM_PREAMBLE };

    for (let step = 0; step < maxSteps; step++) {
      const filesAtCut = listAttachmentMetasAtCut(workingFacts as any);
      const xmlHistory = buildXmlHistory(workingFacts as any, myId, counterpartId);
      const availableFilesXml = buildAvailableFilesXml(filesAtCut);
      const toolsCatalog = buildToolsCatalog(scenario, myId, { allowSendToRemote }, enabledScenarioTools, Array.from(coreAllowed));
      const finalizationReminder = buildFinalizationReminder(workingFacts as any, scenario, myId) || undefined;
      const prompt = buildPlannerPrompt(scenario, myId, counterpartId, xmlHistory, availableFilesXml, toolsCatalog, finalizationReminder);

      try { ctx.hud('planning', 'Thinking…', 0.5); } catch {}
      let decision: ParsedDecision;
      try {
        decision = await chatForDecisionWithRetry(ctx, { model, sys, prompt });
      } catch (e:any) {
        const errMsg = String(e?.message || e || 'planner error');
        const msg = `We hit a temporary error while drafting (details: ${errMsg}). If you want us to continue, please reply or try again.`;
        out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text: msg, nextStateHint: 'input-required', ...(includeWhy ? { why:'Planner error after 3 attempts.' } : {}) } as ProposedFact));
        break;
      }
      const reasoning = decision.reasoning || 'Planner step.';

      // Dispatch
      if (decision.tool === 'sleep') {
        out.push(sleepFact('LLM chose to sleep.', includeWhy, reasoning));
        break;
      }

      if (decision.tool === 'sendMessageToMyPrincipal') {
        if (!coreAllowed.has('sendMessageToMyPrincipal')) { out.push(sleepFact('Core tool disabled: sendMessageToMyPrincipal', includeWhy)); break; }
        const promptText = String(decision.args?.text || '').trim();
        if (!promptText) { out.push(sleepFact('sendMessageToMyPrincipal: empty text → sleep', includeWhy, reasoning)); break; }
        out.push(({ type:'agent_question', qid: ctx.newId('q:'), prompt: promptText, required:false, ...(includeWhy ? { why: reasoning } : {}) } as ProposedFact));
        break;
      }

      if (decision.tool === 'askUser' || decision.tool === 'ask_user') {
        const promptText = String(decision.args?.prompt || '').trim();
        if (!promptText) { out.push(sleepFact('askUser: empty prompt → sleep', includeWhy, reasoning)); break; }
        out.push(({ type:'agent_question', qid: ctx.newId('q:'), prompt: promptText, required: !!decision.args?.required, placeholder: typeof decision.args?.placeholder === 'string' ? decision.args.placeholder : undefined, ...(includeWhy ? { why: reasoning } : {}) } as ProposedFact));
        break;
      }

      if (decision.tool === 'readAttachment' || decision.tool === 'read_attachment') {
        if (!coreAllowed.has('readAttachment')) { out.push(sleepFact('Core tool disabled: readAttachment', includeWhy)); break; }
        const name = String(decision.args?.name || '').trim();
        const callId = ctx.newId('call:read');
        try { ctx.hud('tool', `Tool: read_attachment(name=${name || '?'})`, 0.7); } catch {}
        out.push(({ type:'tool_call', callId, name:'read_attachment', args:{ name }, ...(includeWhy ? { why: reasoning } : {}) } as ProposedFact));
        if (name) {
          const rec = await ctx.readAttachment(name);
          if (rec) {
            // Do not persist file content to the ledger; only reflect success.
            // Embed the full file content in the in-memory working facts so the next prompt includes a
            // consistent <tool_result filename="...">...full text...</tool_result> block.
            workingFacts.push({ type:'tool_call', callId, name:'read_attachment', args:{ name } } as any);
            const fullText = b64ToUtf8(rec.bytes);
            workingFacts.push({ type:'tool_result', callId, ok:true, result:{ name, mimeType: rec.mimeType, text: fullText } } as any);
          } else {
            out.push(({ type:'tool_result', callId, ok:false, error:`Attachment '${name}' is not available at this Cut.`, ...(includeWhy ? { why:'readAttachment failed.' } : {}) } as ProposedFact));
            workingFacts.push({ type:'tool_call', callId, name:'read_attachment', args:{ name } } as any);
            workingFacts.push({ type:'tool_result', callId, ok:false } as any);
          }
        } else {
          out.push(({ type:'tool_result', callId, ok:false, error:'Missing name', ...(includeWhy ? { why:'readAttachment missing name.' } : {}) } as ProposedFact));
          workingFacts.push({ type:'tool_call', callId, name:'read_attachment', args:{ name:'' } } as any);
          workingFacts.push({ type:'tool_result', callId, ok:false } as any);
        }
        // continue loop
        continue;
      }

      if (decision.tool === 'done') {
        if (!coreAllowed.has('done')) { out.push(sleepFact('Core tool disabled: done', includeWhy)); } else { out.push(sleepFact('Planner declared done.', includeWhy, reasoning)); }
        break;
      }

      if (decision.tool === 'sendMessageToRemoteAgent') {
        if (!coreAllowed.has('sendMessageToRemoteAgent')) { out.push(sleepFact('Core tool disabled: sendMessageToRemoteAgent', includeWhy)); break; }
        const attList = Array.isArray(decision.args?.attachments) ? decision.args.attachments : [];
        const filesNow = listAttachmentMetasAtCut(workingFacts as any);
        const known = new Set(filesNow.map(a => a.name));
        const missing = attList.map((a:any)=>String(a?.name||'').trim()).filter((n:string)=>!!n && !known.has(n));
        if (missing.length) { out.push(sleepFact(`Attachments missing: ${missing.join(', ')}.`, includeWhy, reasoning)); break; }
        const composeId = ctx.newId('c:');
        const text = String(decision.args?.text || '').trim() || defaultComposeFromScenario(scenario, myId);
        const metaList: AttachmentMeta[] = attList.map((a:any)=>String(a?.name||'')).filter(Boolean).map((name:string)=>({ name, mimeType: filesNow.find(x=>x.name===name)?.mimeType || 'application/octet-stream' }));
          out.push(({ type:'compose_intent', composeId, text, attachments: metaList.length ? metaList : undefined, ...(includeWhy ? { why: reasoning } : {}), nextStateHint: (buildFinalizationReminder(workingFacts as any, scenario, myId) ? 'completed' : 'working') } as ProposedFact));
        try { ctx.hud('drafting', 'Prepared draft', 0.8); } catch {}
        break;
      }

      // Scenario tool name
      if (enabledScenarioTools && !enabledScenarioTools.includes(decision.tool)) { out.push(sleepFact(`Tool '${decision.tool}' disabled`, includeWhy, reasoning)); break; }
      const tdef = findScenarioTool(scenario, myId, decision.tool);
      if (!tdef) { out.push(sleepFact(`Unknown tool '${decision.tool}' → sleep.`, includeWhy, reasoning)); break; }

      const callId = ctx.newId(`call:${decision.tool}:`);
      try { ctx.hud('tool', `Tool: ${decision.tool}(${shortArgs(decision.args || {})})`, 0.7); } catch {}
      out.push(({ type:'tool_call', callId, name: decision.tool, args: decision.args || {}, ...(includeWhy ? { why: reasoning } : {}) } as ProposedFact));
      const exec = await runToolOracle({ tool: tdef, args: decision.args || {}, scenario, myAgentId: myId, conversationHistory: xmlHistory, leadingThought: reasoning, llm: ctx.llm, model });
      if (!exec.ok) {
        out.push(({ type:'tool_result', callId, ok:false, error: exec.error || 'Tool failed', ...(includeWhy ? { why:'Tool execution error.' } : {}) } as ProposedFact));
        out.push(sleepFact('Tool error → sleeping.', includeWhy));
        break;
      }
      out.push(({ type:'tool_result', callId, ok:true, result: exec.result ?? null, ...(includeWhy ? { why:'Tool execution succeeded.' } : {}) } as ProposedFact));
      for (const doc of exec.attachments) out.push(({ type:'attachment_added', name: doc.name, mimeType: doc.mimeType, bytes: doc.bytesBase64, origin:'synthesized', producedBy:{ callId, name: tdef.toolName, args: decision.args || {} }, ...(includeWhy ? { why:'Synthesized by scenario tool.' } : {}) } as ProposedFact));
      // Update working facts
      workingFacts.push({ type:'tool_call', callId, name: decision.tool, args: decision.args || {} } as any);
      workingFacts.push({ type:'tool_result', callId, ok:true, result: exec.result ?? null } as any);
      for (const doc of exec.attachments) workingFacts.push({ type:'attachment_added', name: doc.name, mimeType: doc.mimeType, bytes: doc.bytesBase64, origin:'synthesized', producedBy:{ callId, name: tdef.toolName } } as any);
      // continue loop (if terminal, next iteration will finalize via FINALIZATION_REMINDER)
    }

    if (!out.length) out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text:'We are still preparing the requested information; we will follow up shortly.' } as ProposedFact));
    return out;
  }
};

// -----------------------------
// Prompt + parsing
// -----------------------------

const SYSTEM_PREAMBLE = `
You are a turn-based agent planner. Respond with JSON only.
`;

type ParsedDecision = { reasoning: string; tool: string; args: any };

function shortArgs(a: any): string {
  try {
    const s = JSON.stringify(a ?? {});
    if (s.length <= 80) return s;
    return s.slice(0, 77) + '…';
  } catch { return ''; }
}

// Centralized wrapper: retry up to 3x until a valid decision JSON is parsed
async function chatForDecisionWithRetry(ctx: PlanContext<any>, opts: { model?: string; sys: LlmMessage; prompt: string }): Promise<ParsedDecision> {
  const req: { model?: string; messages: LlmMessage[]; temperature?: number; signal?: AbortSignal } = {
    model: opts.model,
    messages: [opts.sys, { role: 'user', content: opts.prompt }],
    temperature: 0.5,
    signal: ctx.signal,
  };
  const retryMessages: LlmMessage[] = [
    { role: 'system', content: 'Return exactly one JSON object with keys "reasoning" and "action". No extra text.' }
  ];
  return chatWithValidationRetry(ctx.llm, req, (text) => parseActionStrict(text), { attempts: 3, retryMessages });
}

function parseActionStrict(text: string): ParsedDecision {
  const raw = String(text || '').trim();
  const m = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
  const candidate = m?.[1]?.trim() ?? raw;
  const i = candidate.indexOf('{'); const j = candidate.lastIndexOf('}');
  const body = i >= 0 && j > i ? candidate.slice(i, j + 1) : candidate;
  let obj: any;
  try { obj = JSON.parse(body); } catch { throw new Error('Invalid JSON'); }
  if (!obj || typeof obj !== 'object') throw new Error('Response not an object');
  const action = (obj as any).action || (obj as any).toolCall || {};
  const tool = String((action as any).tool || '').trim();
  const args = (action as any).args || {};
  const reasoning = String((obj as any).reasoning || (obj as any).thought || '').trim();
  if (!tool) throw new Error('Missing action.tool');
  return { reasoning, tool, args };
}

// -----------------------------
// History & attachments helpers
// -----------------------------

import type { A2AStatus } from '../../../shared/a2a-types';
type A2AStatusLike = A2AStatus | 'initializing';

function getLastStatus(facts: ReadonlyArray<Fact>): A2AStatusLike | undefined {
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i];
    if (f.type === 'status_changed') return (f as Extract<Fact, { type: 'status_changed' }>).a2a;
  }
  return undefined;
}

function hasAskedWrapUp(facts: ReadonlyArray<Fact>): boolean {
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i];
    if (f.type === 'agent_question' && /^wrapup:/.test(f.qid)) return true;
  }
  return false;
}

function findOpenQuestion(facts: ReadonlyArray<Fact>): { qid: string } | null {
  // Find the latest agent_question and see if a matching user_answer exists later.
  let lastQid: string | null = null;
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i];
    if (f.type === 'agent_question') { lastQid = f.qid; break; }
  }
  if (!lastQid) return null;
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i] as any;
    if (f.type === 'user_answer' && f.qid === lastQid) return null;
  }
  return { qid: lastQid };
}

function listAttachmentMetasAtCut(facts: ReadonlyArray<Fact>): AttachmentMeta[] {
  const seen = new Map<string, AttachmentMeta>();
  for (const f of facts) {
    if (f.type === 'attachment_added') {
      if (!seen.has(f.name)) seen.set(f.name, { name: f.name, mimeType: f.mimeType, origin: f.origin, size: f.bytes?.length });
    }
  }
  return Array.from(seen.values());
}

function buildXmlHistory(facts: ReadonlyArray<Fact>, me: string, other: string): string {
  const lines: string[] = [];
  for (const f of facts) {
    if (f.type === 'remote_sent') {
      // Planner → counterpart
      lines.push(`<message from="${me}" to="${other}">`);
      if (f.text) lines.push(escapeXml(f.text));
      for (const a of f.attachments || []) lines.push(`<attachment name="${a.name}" mimeType="${a.mimeType}" />`);
      lines.push(`</message>`);
    } else if (f.type === 'remote_received') {
      // Counterpart → planner
      lines.push(`<message from="${other}" to="${me}">`);
      if (f.text) lines.push(escapeXml(f.text));
      for (const a of f.attachments || []) lines.push(`<attachment name="${a.name}" mimeType="${a.mimeType}" />`);
      lines.push(`</message>`);
    } else if (f.type === 'tool_call') {
      const body = { action: { tool: f.name, args: f.args } };
      lines.push(`<tool_call>${escapeXml(JSON.stringify(body))}</tool_call>`);
    } else if (f.type === 'tool_result') {
      // Prefer document rendering if available
      const ok = (f as any).ok !== false;
      const result: any = ok ? (f as any).result : { ok: false, error: (f as any).error };
      let rendered = false;
      try {
        const docs: any[] = Array.isArray(result?.documents) ? result.documents : [];
        const single = (result && typeof result === 'object' && (result.name || result.docId)) ? [result] : [];
        const all = (docs.length ? docs : single) as any[];
        for (const d of all) {
          const name = String(d?.name || d?.docId || 'result');
          const body = typeof d?.content === 'string' ? d.content : (typeof d?.text === 'string' ? d.text : undefined);
          if (name && typeof body === 'string' && body) {
            const safe = escapeXml(body);
            lines.push(`<tool_result filename="${escapeXml(name)}">\n${safe}\n</tool_result>`);
            rendered = true;
          }
        }
      } catch {}
      if (!rendered) lines.push(`<tool_result>${escapeXml(JSON.stringify(result ?? {}))}</tool_result>`);
    } else if (f.type === 'agent_question') {
      // Represent private question as plain message envelope
      lines.push(`<message from="${me}" to="user">`);
      lines.push(escapeXml(f.prompt));
      lines.push(`</message>`);
    } else if ((f as any).type === 'user_answer') {
      const ua = f as any;
      lines.push(`<message from="user" to="${me}">`);
      lines.push(escapeXml(String(ua.text || '')));
      lines.push(`</message>`);
    }
  }
  return lines.join('\n');
}

function buildAvailableFilesXml(files: AttachmentMeta[]): string {
  if (!files.length) return '<!-- none -->';
  const rows = files.map(a => {
    const name = escapeXml(a.name);
    const mimeType = escapeXml(a.mimeType || 'application/octet-stream');
    const size = typeof (a as any).size === 'number' ? (a as any).size : (a as any).bytes?.length;
    const sizeStr = typeof size === 'number' && Number.isFinite(size) ? String(size) : '0';
    const source = escapeXml(a.origin || 'ledger');
    const priv = 'false';
    return `<file name="${name}" mimeType="${mimeType}" size="${sizeStr}" source="${source}" private="${priv}" />`;
  });
  return rows.join('\n');
}

function escapeXml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function defaultComposeFromScenario(scenario: ScenarioConfiguration, myId: string): string {
  const me = scenario?.agents?.find(a => a.agentId === myId);
  return me?.messageToUseWhenInitiatingConversation
    || `Hello, I represent ${me?.principal?.name ?? 'our principal'}. Following up on the request.`;
}

// Build the planner prompt combining scenario context, history, files, and tools catalog
function buildPlannerPrompt(
  scenario: ScenarioConfiguration,
  myId: string,
  otherId: string,
  xmlHistory: string,
  availableFilesXml: string,
  toolsCatalog: string,
  finalizationReminder?: string | null
): string {
  const me = scenario.agents.find(a => a.agentId === myId);
  const others = (scenario.agents || []).filter(a => a.agentId !== myId);

  const parts: string[] = [];

  // SCENARIO block
  parts.push('<SCENARIO>');
  const md = (scenario as any).metadata || {};
  if (md.title || md.id) parts.push(`Title: ${md.title || md.id}`);
  if (md.description) parts.push(`Description: ${md.description}`);
  if (md.background) parts.push(`Background: ${md.background}`);
  if (me) {
    parts.push('<YOUR_ROLE>');
    parts.push(`You are agent "${me.agentId}" for ${me.principal?.name || 'Unknown'}.`);
    if (me.principal?.description) parts.push(`Principal Info: ${me.principal.description}`);
    if (me.principal?.type) parts.push(`Principal Type: ${me.principal.type}`);
    if (me.systemPrompt) parts.push(`System: ${me.systemPrompt}`);
    if (me.situation) parts.push(`Situation: ${me.situation}`);
    if (Array.isArray(me.goals) && me.goals.length) parts.push('Goals:\n' + me.goals.map((g:any) => `- ${g}`).join('\n'));
    parts.push('</YOUR_ROLE>');
  }
  if (others.length) {
    parts.push('Counterparts:');
    for (const a of others) {
      const info: string[] = [];
      info.push(`${a.agentId} (for ${a.principal?.name || 'Unknown'})`);
      if (a.principal?.description) info.push(`desc: ${a.principal.description}`);
      if (a.principal?.type) info.push(`type: ${a.principal.type}`);
      parts.push(`- ${info.join('; ')}`);
    }
  }
  parts.push('</SCENARIO>');
  parts.push('');

  // EVENT LOG
  parts.push('<EVENT_LOG>');
  parts.push(xmlHistory || '<!-- none -->');
  parts.push('</EVENT_LOG>');
  parts.push('');

  // AVAILABLE FILES
  parts.push('<AVAILABLE_FILES>');
  parts.push(availableFilesXml || '<!-- none -->');
  parts.push('</AVAILABLE_FILES>');
  parts.push('');

  // TOOLS CATALOG
  parts.push(toolsCatalog);

  // TOOLING GUIDANCE (nudge toward scenario tools over free-form)
  parts.push('<TOOLING_GUIDANCE>');
  parts.push('- Prefer scenario-specific tools to advance the task.');
  parts.push('- Use read_attachment only to inspect existing files; to generate new content, invoke scenario tools that synthesize documents or results.');
  parts.push('- Before sending a free-form message, consider if a tool can produce a clearer, more authoritative outcome.');
  parts.push("- When a tool is terminal (endsConversation=true), compose one final message, attach its outputs, and set nextState='completed'.");
  parts.push("- Keep all exchange in this conversation thread; do not refer to portals/emails/fax.");
  parts.push('</TOOLING_GUIDANCE>');

  // FINALIZATION REMINDER (optional)
  if (finalizationReminder && finalizationReminder.trim()) {
    parts.push(finalizationReminder.trim());
    parts.push('');
  }

  // Suggested starting message if we haven't initiated yet
  try {
    const hasPlannerContact = /<message from=\"[^\"]+\" to=\"[^\"]+\">/i.test(xmlHistory || '');
    if (!hasPlannerContact) {
      const suggested: string | undefined = me?.messageToUseWhenInitiatingConversation || (me as any)?.initialMessage || undefined;
      if (suggested && String(suggested).trim()) {
        parts.push('<suggested_starting_message>');
        parts.push(String(suggested).trim());
        parts.push('</suggested_starting_message>');
        parts.push('');
      }
    }
  } catch {}

  // RESPONSE footer
  parts.push('<RESPONSE>');
  parts.push("Output exactly one JSON object with fields 'reasoning' and 'action'. No extra commentary or code fences.");
  parts.push('</RESPONSE>');

  return parts.join('\n');
}

function buildFinalizationReminder(facts: ReadonlyArray<Fact>, scenario: ScenarioConfiguration, myId: string): string | null {
  // Find last tool_call that is terminal per scenario config
  const me = scenario.agents.find(a => a.agentId === myId) || scenario.agents[0];
  const terminalToolNames = new Set<string>((me?.tools || []).filter(t => t.endsConversation).map(t => t.toolName));
  if (!terminalToolNames.size) return null;

  let lastIdx = -1;
  let lastCallId: string | null = null;
  let lastToolName: string | null = null;
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i];
    if (f.type === 'tool_call' && terminalToolNames.has(f.name)) {
      lastIdx = i;
      lastCallId = f.callId;
      lastToolName = f.name;
      break;
    }
  }
  if (lastIdx < 0 || !lastCallId) return null;

  // If any remote_sent happened after this call, no reminder needed
  for (let i = facts.length - 1; i > lastIdx; i--) {
    const f = facts[i];
    if (f.type === 'remote_sent') return null;
  }

  // Collect attachments produced by this call
  const attachments: string[] = [];
  for (let i = lastIdx + 1; i < facts.length; i++) {
    const f = facts[i] as any;
    if (f.type === 'attachment_added' && f.producedBy && f.producedBy.callId === lastCallId) {
      attachments.push(String(f.name));
    }
  }

  // Extract note from tool_result
  let note: string | undefined;
  for (let i = lastIdx + 1; i < facts.length; i++) {
    const f = facts[i] as any;
    if (f.type === 'tool_result' && f.callId === lastCallId && f.ok !== false) {
      const output = f.result;
      if (output && typeof output === 'object') {
        const s = (output as any).summary;
        const n = (output as any).note;
        if (typeof s === 'string' && s.trim()) { note = s.trim(); break; }
        if (typeof n === 'string' && n.trim()) { note = n.trim(); break; }
      }
    }
  }

  const lines: string[] = [];
  lines.push('<FINALIZATION_REMINDER>');
  lines.push('You have invoked a terminal tool that ends the conversation.');
  lines.push("Compose ONE final message to the remote agent:");
  lines.push('- Summarize the outcome and key reasons.');
  lines.push("- Attach the terminal tool's output files below.");
  lines.push("- Set nextState to 'completed'.");
  if (attachments.length) {
    lines.push('Files to attach:');
    for (const name of attachments) lines.push(`- ${name}`);
  }
  if (note) lines.push(`Note: ${note}`);
  lines.push('</FINALIZATION_REMINDER>');
  return lines.join('\n');
}

// -----------------------------
// Tools catalog presented to LLM
// -----------------------------

function buildToolsCatalog(
  scenario: ScenarioConfiguration,
  myAgentId: string,
  _opts: { allowSendToRemote: boolean },
  enabledTools?: string[],
  enabledCoreTools?: string[]
) {
  const lines: string[] = [];
  lines.push('<TOOLS>');
  lines.push('Respond with exactly ONE JSON object describing your reasoning and chosen action.');
  lines.push('Schema: { reasoning: string, action: { tool: string, args: object } }');
  lines.push('');

  const coreAllowed = new Set<string>(Array.isArray(enabledCoreTools) && enabledCoreTools.length ? enabledCoreTools : ['sendMessageToRemoteAgent','sendMessageToMyPrincipal','readAttachment','sleep','done']);
  // Core: sendMessageToRemoteAgent
  if (coreAllowed.has('sendMessageToRemoteAgent')) {
    lines.push("// Send a message to the remote agent. Attachments by 'name'.");
    lines.push("interface SendMessageToRemoteAgentArgs { text?: string; attachments?: Array<{ name: string }>; nextState?: 'working'|'input-required'|'completed'|'canceled'|'failed'|'rejected'|'auth-required'; }");
    lines.push('Tool: sendMessageToRemoteAgent: SendMessageToRemoteAgentArgs');
    lines.push('');
  }

  // Principal messaging
  try {
    const me = (scenario?.agents || []).find(a => a.agentId === myAgentId);
    const pType = String(me?.principal?.type || '').trim();
    const pName = String(me?.principal?.name || '').trim();
    const typeLabel = pType ? (pType === 'individual' ? 'individual' : pType === 'organization' ? 'organization' : pType) : '';
    const descSuffix = pName && typeLabel ? ` (${typeLabel}: ${pName})` : (pName ? ` (${pName})` : '');
    if (coreAllowed.has('sendMessageToMyPrincipal')) lines.push(`// Send a message to your principal${descSuffix}.`);
  } catch {
    if (coreAllowed.has('sendMessageToMyPrincipal')) lines.push('// Send a message to your principal.');
  }
  if (coreAllowed.has('sendMessageToMyPrincipal')) {
    lines.push('interface sendMessageToMyPrincipalArgs { text: string; attachments?: Array<{ name: string }>; }');
    lines.push('Tool: sendMessageToMyPrincipal: sendMessageToMyPrincipalArgs');
    lines.push('');
  }

  // Sleep
  if (coreAllowed.has('sleep')) {
    lines.push('// Sleep until a new event arrives (no arguments).');
    lines.push('type SleepArgs = {};');
    lines.push('Tool: sleep: SleepArgs');
    lines.push('');
  }

  // Read attachment
  if (coreAllowed.has('readAttachment')) {
    lines.push('// Read a previously uploaded attachment by name (from AVAILABLE_FILES).');
    lines.push('interface ReadAttachmentArgs { name: string }');
    lines.push('Tool: readAttachment: ReadAttachmentArgs');
    lines.push('');
  }

  // Done
  if (coreAllowed.has('done')) {
    lines.push("// Declare that you're fully done.");
    lines.push('interface DoneArgs { summary?: string }');
    lines.push('Tool: done: DoneArgs');
  }

  // Scenario tools
  const me = (scenario?.agents || []).find(a => a.agentId === myAgentId) || scenario?.agents?.[0];
  const tools = (me?.tools || []).filter((t:any) => !enabledTools || enabledTools.includes(t.toolName));
  if (tools.length) {
    lines.push('');
    lines.push('Scenario-Specific Tools:');
    for (const t of tools) {
      lines.push(`// ${t.description}`.trim());
      const iface = schemaToTsInterface(t.inputSchema);
      lines.push(`interface ${t.toolName}Args ${iface}`);
      lines.push(`Tool: ${t.toolName}: ${t.toolName}Args`);
      lines.push('');
    }
  }

  lines.push('</TOOLS>');
  return lines.join('\n');
}

function schemaToTsInterface(schema: any, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (!schema || typeof schema !== 'object') return '{ }';
  const t = schema.type;
  if (t === 'string' || t === 'number' || t === 'boolean') return `{ value: ${t} }`;
  if (t === 'integer') return `{ value: number }`;
  if (t === 'array') {
    const it = schema.items ? schemaToTsInterface(schema.items, indent + 1) : '{ }';
    return `{ items: Array<${it}> }`;
  }
  // object
  const req: string[] = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties || {};
  const lines: string[] = ['{'];
  for (const k of Object.keys(props)) {
    const opt = req.includes(k) ? '' : '?';
    const doc = props[k]?.description ? ` // ${String(props[k].description)}` : '';
    const typeRendered = schemaToTs(props[k], indent + 1);
    lines.push(`${pad}  ${k}${opt}: ${typeRendered};${doc}`);
  }
  lines.push(pad + '}');
  return lines.join('\n');
}

function schemaToTs(schema: any, indent = 0): string {
  const t = schema?.type;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  if (t === 'integer') return 'number';
  if (t === 'array') return `Array<${schemaToTs(schema.items, indent + 1)}>`;
  if (t === 'object' || schema.properties) {
    const props = schema.properties || {};
    const req: string[] = Array.isArray(schema.required) ? schema.required : [];
    const parts: string[] = ['{'];
    for (const k of Object.keys(props)) {
      const opt = req.includes(k) ? '' : '?';
      parts.push(`${'  '.repeat(indent + 1)}${k}${opt}: ${schemaToTs(props[k], indent + 1)};`);
    }
    parts.push(`${'  '.repeat(indent)}}`);
    return parts.join('\n');
  }
  return 'any';
}

// -----------------------------
// Tool Oracle (LLM-synth) – minimal, deterministic envelope
// -----------------------------

type OracleExec = {
  ok: boolean;
  error?: string;
  result?: unknown;
  attachments: Array<{ name: string; mimeType: string; bytesBase64: string }>;
};

async function runToolOracle(opts: {
  tool: ScenarioTool;
  args: Record<string, unknown>;
  scenario: ScenarioConfiguration;
  myAgentId: string;
  conversationHistory?: string;
  leadingThought?: string;
  llm: PlanContext['llm'];
  model?: string;
}): Promise<OracleExec> {
  const prompt = buildOraclePromptAligned(opts);
  try {
    const req = { model: opts.model, messages: [{ role: 'user', content: prompt }], temperature: 0.6 } as const;
    const retryMessages: LlmMessage[] = [
      { role: 'system', content: 'Return exactly one JSON code block with keys "reasoning" (string) and "output" (JSON). No extra text.' }
    ];
    const parsed = await chatWithValidationRetry(opts.llm, req as any, (text) => parseOracleResponseAligned(text), { attempts: 3, retryMessages });
    const { output } = parsed;
    const attachments = extractAttachmentsFromOutput(output);
    return { ok: true, result: output, attachments };
  } catch (e:any) {
    return { ok: false, error: String(e?.message || 'oracle failed'), attachments: [] };
  }
}

function buildOraclePromptAligned(opts: {
  tool: ScenarioTool;
  args: Record<string, unknown>;
  scenario: ScenarioConfiguration;
  myAgentId: string;
  conversationHistory?: string;
  leadingThought?: string;
}): string {
  const { scenario, myAgentId, tool, args, conversationHistory, leadingThought } = opts;
  const me = scenario.agents.find(a => a.agentId === myAgentId) || scenario.agents[0];
  const history = truncateText(conversationHistory || '', 20000, '... [history truncated]');

  const scenarioMeta = {
    id: scenario.metadata?.id,
    title: scenario.metadata?.title,
    description: scenario.metadata?.description,
    background: (scenario.metadata as any)?.background,
    challenges: (scenario.metadata as any)?.challenges,
    tags: scenario.metadata?.tags,
  };

  const kbSelf = me?.knowledgeBase ?? {};
  const kbSelfStr = safeStringify(kbSelf);
  const kbSelfTrunc = truncateText(kbSelfStr, 30000, '... [calling agent knowledge truncated]');

  const others = (scenario.agents || []).filter(a => a.agentId !== (me?.agentId || ''));
  let remaining = 30000;
  const otherKbLines: string[] = [];
  for (const o of others) {
    const header = `- agentId: ${o.agentId} (${o.principal?.name || 'Unknown'})`;
    const body = safeStringify(o.knowledgeBase || {});
    const budget = Math.max(1000, Math.min(remaining, 30000));
    const trunc = truncateText(body, budget, '... [other agent knowledge truncated]');
    otherKbLines.push(`${header}\n${trunc}`);
    remaining -= (trunc.length + header.length + 1);
    if (remaining <= 0) break;
  }
  const otherKbBlock = otherKbLines.length
    ? ['OTHER AGENTS KNOWLEDGE (Omniscient view, reveal only what the tool plausibly knows):', ...otherKbLines].join('\n')
    : 'OTHER AGENTS KNOWLEDGE: (none present or budget exhausted)';

  const scenarioKnowledge = formatScenarioKnowledgeAligned(scenario);
  const directorsNote = tool.synthesisGuidance || '';
  const terminalNote = tool.endsConversation
    ? `This tool is TERMINAL (endsConversation=true). Your output should help conclude the conversation. outcome="${tool.conversationEndStatus ?? 'neutral'}".`
    : `This tool is NOT terminal. Produce output to advance the conversation.`;

  const outputFormats = [
    '<OUTPUT_FORMATS>',
    'Choose exactly one top-level style for the value of "output":',
    '- Document style: use <DOCUMENT_OUTPUT> when the natural result is a narrative, letter, note, summary, or other document meant for humans to read.',
    '- JSON style: use <JSON_OBJECT_OUTPUT> when the natural result is structured data (records, statuses, parameters, computed results).',
    'Do not mix both at the top level. If you choose JSON style, you may include a nested field like "document".',
    '',
    '  <DOCUMENT_OUTPUT>',
    '  {',
    '    "docId": "unique-document-id",',
    '    "name": "filename.md",',
    '    "contentType": "text/markdown",',
    '    "content": "The document content...",',
    '    "summary": "Optional short summary"',
    '  }',
    '  </DOCUMENT_OUTPUT>',
    '',
    '  <JSON_OBJECT_OUTPUT>',
    '  {',
    '    // Idiomatic fields for the tool\'s output',
    '    // Rich and detailed, lifelike, structured cleanly',
    '  }',
    '  </JSON_OBJECT_OUTPUT>',
    '',
    '</OUTPUT_FORMATS>'
  ].join('\n');

  const constraints = [
    '<CONSTRAINTS>',
    '- The conversation thread is the sole channel of exchange.',
    '- Do NOT suggest portals, emails, fax, or separate submission flows.',
    '- Encourage sharing documents via conversation attachments (by docId) when appropriate.',
    '- Reveal only what the specific tool would plausibly know, even though you are omniscient.',
    '</CONSTRAINTS>'
  ].join('\n');

  const outputContract = [
    '<OUTPUT_CONTRACT>',
    '- Return exactly one framing JSON code block.',
    '- The framing JSON MUST have keys: "reasoning" (string) and "output" (a DOCUMENT_OUTPUT or JSON_OUTPUT).',
    '- No extra text outside the code block.',
    '',
    '  <EXAMPLE>',
    '  ```json',
    '  {',
    '    "reasoning": "How you derived the output from context & tool intent.",',
    '    "output": {',
    '      "docId": "doc_policy_123",',
    '      "name": "filename.md",',
    '      "contentType": "text/markdown",',
    '      "content": "# Policy ...",',
    '      "summary": "Highlights the specific criteria and applicability to this case."',
    '    }',
    '  }',
    '  ```',
    '  </EXAMPLE>',
    '</OUTPUT_CONTRACT>'
  ].join('\n');

  const lines: string[] = [];
  lines.push('<SYSTEM_ROLE>');
  lines.push('You are an omniscient Oracle / World Simulator for a scenario-driven, multi-agent conversation.');
  lines.push('Your role: execute a tool call with realistic, in-character results.');
  lines.push('</SYSTEM_ROLE>');
  lines.push('');
  lines.push('<SCENARIO>');
  lines.push(formatScenarioHeaderAligned(scenario));
  lines.push('</SCENARIO>');
  lines.push('');
  lines.push('<AGENT_PROFILE>');
  lines.push(formatAgentProfileAligned(me));
  lines.push('</AGENT_PROFILE>');
  lines.push('');
  lines.push('<CALLING_AGENT_KB>');
  lines.push(kbSelfTrunc || '(none)');
  lines.push('</CALLING_AGENT_KB>');
  lines.push('');
  lines.push('<SCENARIO_KNOWLEDGE>');
  lines.push(scenarioKnowledge);
  lines.push('</SCENARIO_KNOWLEDGE>');
  lines.push('');
  lines.push('<SCENARIO_METADATA>');
  lines.push(safeStringify(scenarioMeta));
  lines.push('</SCENARIO_METADATA>');
  lines.push('');
  if (leadingThought) {
    lines.push('<AGENT_THOUGHT_LEADING_TO_TOOL_CALL>');
    lines.push(leadingThought);
    lines.push('</AGENT_THOUGHT_LEADING_TO_TOOL_CALL>');
    lines.push('');
  }
  lines.push('<TOOL_INVOCATION>');
  lines.push(`- name: ${tool.toolName}`);
  lines.push(`- description: ${tool.description || '(no description provided)'}`);
  lines.push(`- inputSchema: ${safeStringify(tool.inputSchema ?? { type: 'object' })}`);
  lines.push(`- arguments: ${safeStringify(args)}`);
  lines.push('</TOOL_INVOCATION>');
  lines.push('');
  lines.push('<DIRECTORS_NOTE>');
  lines.push(directorsNote);
  lines.push('</DIRECTORS_NOTE>');
  lines.push('');
  lines.push('<TERMINAL_NOTE>');
  lines.push(terminalNote);
  lines.push('</TERMINAL_NOTE>');
  lines.push(constraints);
  lines.push(outputFormats);
  lines.push('');
  if (history) {
    lines.push('<CONVERSATION_HISTORY>');
    lines.push(history);
    lines.push('</CONVERSATION_HISTORY>');
    lines.push('');
  }
  lines.push(outputContract);
  lines.push(`Now produce your response to "${tool.toolName}" and remember the synthesis guidance: ${directorsNote}`);
  return lines.join('\n');
}

function formatScenarioHeaderAligned(s: ScenarioConfiguration): string {
  const title = s.metadata?.title || '(untitled)';
  const desc = s.metadata?.description || '';
  const tags = s.metadata?.tags?.length ? ` [tags: ${s.metadata.tags.join(', ')}]` : '';
  return [
    'SCENARIO:',
    `- id: ${s.metadata?.id ?? '(missing-id)'}`,
    `- title: ${title}${tags}`,
    `- description: ${desc}`,
  ].join('\n');
}

function formatScenarioKnowledgeAligned(s: ScenarioConfiguration): string {
  const k = (s as any).knowledge;
  if (!k) return 'SCENARIO KNOWLEDGE: (none)';
  const facts = Array.isArray(k.facts) && k.facts.length ? k.facts.map((f: string, i: number) => `  ${i + 1}. ${f}`).join('\n') : '  (none)';
  const documents = Array.isArray(k.documents) && k.documents.length ? k.documents.map((d: any) => `  - [${d.id}] ${d.title} (${d.type})`).join('\n') : '  (none)';
  const refs = Array.isArray(k.references) && k.references.length ? k.references.map((r: any) => `  - ${r.title}: ${r.url}`).join('\n') : '  (none)';
  return [
    'SCENARIO KNOWLEDGE (shared ground-truth available to the Oracle):',
    'Facts:',
    facts,
    'Documents (IDs usable for synthesized refs):',
    documents,
    'References:',
    refs,
  ].join('\n');
}

function formatAgentProfileAligned(a: any): string {
  const principal = a?.principal ? `${a.principal.name} — ${a.principal.description}` : '(principal not specified)';
  const goals = Array.isArray(a?.goals) && a.goals.length ? a.goals.map((g: string) => `  - ${g}`).join('\n') : '  (none)';
  return [
    'CALLING AGENT PROFILE:',
    `- agentId: ${a?.agentId || '(unknown)'}`,
    `- principal: ${principal}`,
    `- situation: ${a?.situation || '(not specified)'}`,
    `- systemPrompt: ${a?.systemPrompt || '(not specified)'}`,
    '- goals:',
    goals,
  ].join('\n');
}

function parseOracleResponseAligned(content: string): { reasoning: string; output: unknown } {
  // Try ```json ... ```
  const jsonBlock = content.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlock?.[1]) {
    const obj = tryParseJson(jsonBlock[1]);
    if (obj && typeof obj.reasoning === 'string' && 'output' in obj) return { reasoning: obj.reasoning, output: obj.output };
  }
  // Try generic ``` ... ```
  const codeBlock = content.match(/```\s*([\s\S]*?)\s*```/);
  if (codeBlock?.[1]) {
    const obj = tryParseJson(codeBlock[1]);
    if (obj && typeof obj.reasoning === 'string' && 'output' in obj) return { reasoning: obj.reasoning, output: obj.output };
  }
  // Try first bare JSON object
  const bare = extractFirstJsonObjectAligned(content);
  if (bare) {
    const obj = tryParseJson(bare);
    if (obj && typeof obj.reasoning === 'string' && 'output' in obj) return { reasoning: obj.reasoning, output: obj.output };
  }
  // Heuristic fallback
  const heuristic = heuristicParseAligned(content);
  if (heuristic) return heuristic;
  throw new Error('Oracle response was not valid JSON with required { reasoning, output } shape.');
}

function tryParseJson(s: string): any | null { try { return JSON.parse(s); } catch { return null; } }

function extractFirstJsonObjectAligned(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function heuristicParseAligned(content: string): { reasoning: string; output: unknown } | null {
  const r = content.match(/"reasoning"\s*:\s*"([^"]*)"/);
  const reasoning = r?.[1] ?? 'No explicit reasoning found (heuristic parse).';
  const idx = content.indexOf('"output"');
  if (idx === -1) return null;
  const after = content.slice(idx + '"output"'.length);
  const colon = after.indexOf(':');
  if (colon === -1) return null;
  const valueStr = after.slice(colon + 1).trim();
  let output: unknown = valueStr;
  const first = valueStr[0];
  if (first === '{' || first === '[' || first === '"') {
    const candidate = extractFirstJsonObjectAligned(valueStr) ?? valueStr;
    const parsed = tryParseJson(candidate);
    if (parsed !== null) output = parsed;
  }
  return { reasoning, output };
}

function extractAttachmentsFromOutput(output: unknown): Array<{ name: string; mimeType: string; bytesBase64: string }> {
  const results: Array<{ name: string; mimeType: string; bytesBase64: string }> = [];
  const maybePushDoc = (d: any) => {
    const name = String(d?.name || '').trim();
    const contentType = String(d?.contentType || 'text/markdown');
    const content = typeof d?.content === 'string' ? d.content : (d?.document && typeof d.document.content === 'string' ? d.document.content : undefined);
    if (name && typeof content === 'string' && content) {
      results.push({ name, mimeType: contentType, bytesBase64: toBase64(content) });
    }
  };
  try {
    if (output && typeof output === 'object') {
      // Direct document output
      if ((output as any).docId || (output as any).name) maybePushDoc(output);
      // Nested document field
      if ((output as any).document) maybePushDoc((output as any).document);
      // Legacy documents array
      const docs = (output as any).documents;
      if (Array.isArray(docs)) for (const d of docs) maybePushDoc(d);
    }
  } catch {}
  return results;
}

function safeStringify(v: unknown): string { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function truncateText(s: string, max: number, suffix = '...'): string {
  if (!s) return s;
  if (s.length <= max) return s;
  if (max <= suffix.length) return s.slice(0, max);
  return s.slice(0, max - suffix.length) + suffix;
}

function parseJsonObject(text: string): any {
  let raw = String(text || '').trim();
  const m = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
  if (m?.[1]) raw = m[1].trim();
  const i = raw.indexOf('{'); const j = raw.lastIndexOf('}');
  const body = i >= 0 && j > i ? raw.slice(i, j + 1) : raw;
  try { return JSON.parse(body); } catch { return {}; }
}

// -----------------------------
// Compose text generation
// -----------------------------

function finalComposeFromTerminal(exec: OracleExec, tool: ScenarioTool, scenario: ScenarioConfiguration, myId: string): string {
  const outcome = tool.conversationEndStatus || 'neutral';
  const me = scenario.agents.find(a => a.agentId === myId);
  const who = me?.principal?.name ? `on behalf of ${me.principal.name}` : 'on behalf of our principal';
  const attList = exec.attachments.map(a => a.name).join(', ');
  const base = `Following our review ${who}, we are sharing the final outcome of this request.`;
  const resultHint = typeof exec.result === 'string'
    ? exec.result
    : (exec.result ? JSON.stringify(exec.result, null, 2) : '');
  const suffix = resultHint ? `\n\nSummary:\n${resultHint}` : '';
  const files = attList ? `\n\nAttachments: ${attList}` : '';
  if (outcome === 'success') {
    return `${base}\nOutcome: Approved.\n${suffix}${files}`;
  } else if (outcome === 'failure') {
    return `${base}\nOutcome: Denied.\n${suffix}${files}`;
  }
  return `${base}\nOutcome: Information provided.\n${suffix}${files}`;
}

function draftComposeFromTool(exec: OracleExec, tool: ScenarioTool, scenario: ScenarioConfiguration, myId: string):
  | { text: string; attachments?: AttachmentMeta[] }
  | null {
  // Simple heuristic: if tool produced docs but isn't terminal, suggest a draft attaching them.
  if (exec.attachments.length) {
    const meta = exec.attachments.map(a => ({ name: a.name, mimeType: a.mimeType }));
    const text = `Sharing requested information produced by ${tool.toolName}. Please review the attached file(s).`;
    return { text, attachments: meta };
  }
  return null;
}

// -----------------------------
// Utilities
// -----------------------------

function toBase64(str: string): string {
  try {
    // Browser-safe UTF8 → base64
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(str)));
  } catch {}
  // Node/Bun fallback
  // eslint-disable-next-line no-undef
  return Buffer.from(str, 'utf-8').toString('base64');
}

// (Replaced ad-hoc decoders with shared b64ToUtf8 from src/shared/codec)

function findScenarioTool(scenario: ScenarioConfiguration, myId: string, toolName: string): ScenarioTool | undefined {
  const me = scenario.agents.find(a => a.agentId === myId) || scenario.agents[0];
  return (me?.tools || []).find(t => t.toolName === toolName);
}

function sleepFact(why: string, includeWhy: boolean, extraWhy?: string): ProposedFact {
  return (includeWhy
    ? { type: 'sleep', reason: why, why: extraWhy ? `${why} — ${extraWhy}` : why }
    : { type: 'sleep', reason: why }) as unknown as ProposedFact;
}
