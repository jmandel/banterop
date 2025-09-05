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
import { chatWithValidationRetry, cleanModelText } from '../../../shared/llm-retry';
import { ScenarioPlannerSetup, dehydrateScenario, hydrateScenario } from './scenario.setup';
import { b64ToUtf8 } from '../../../shared/codec';
import type { ScenarioConfiguration, Tool as ScenarioTool } from '../../../types/scenario-configuration.types'; // ← adjust
import { uniqueName } from '../../../shared/a2a-helpers';

// ---------------------u--------
// Public export
// -----------------------------

export interface ScenarioPlannerConfig {
  scenario: ScenarioConfiguration;  // Pure scenario object
  scenarioUrl: string;              // URL stored separately (no monkeypatch)
  /** Model is selected at client level; cfg no longer carries model. */
  /** Optional list of tool names to enforce; if omitted, all tools enabled. */
  enabledTools?: string[];
  /** Which agent we are playing as (agentId). Defaults to first agent. */
  myAgentId?: string;
  /** Core tools allow-list (send/read/done/principal/sleep). If omitted, defaults to ['sendMessageToRemoteAgent','readAttachment','done']. */
  enabledCoreTools?: string[];
  /** Max planner steps within one pass (reserved; defaults handled by planner). */
  maxInlineSteps?: number;
  /** Optional global additional instructions appended to system prompt. */
  instructions?: string;
}

export const ScenarioPlannerV03: Planner<ScenarioPlannerConfig> = {
  id: 'scenario-v0.3',
  name: 'Scenario Planner (v0.3)',
  // New per-planner setup API
  // @ts-ignore
  SetupComponent: ScenarioPlannerSetup,
  // @ts-ignore
  dehydrate: (cfg: any) => dehydrateScenario({
    scenario: cfg?.scenario,
    scenarioUrl: String(cfg?.scenarioUrl || ''),
    myAgentId: String(cfg?.myAgentId || ''),
    enabledTools: Array.isArray(cfg?.enabledTools) ? cfg.enabledTools : [],
    // Default: omit 'sleep' and 'sendMessageToMyPrincipal' unless explicitly enabled
    enabledCoreTools: Array.isArray(cfg?.enabledCoreTools) ? cfg.enabledCoreTools : ['sendMessageToRemoteAgent','readAttachment','done'],
    maxInlineSteps: Number(cfg?.maxInlineSteps ?? 20),
    instructions: (typeof cfg?.instructions === 'string' && cfg.instructions.trim()) ? String(cfg.instructions) : undefined,
  }),
  // @ts-ignore
  hydrate: async (seed: any, ctx: any) => hydrateScenario(seed, ctx),

  async plan(input: PlanInput, ctx: PlanContext<ScenarioPlannerConfig>): Promise<ProposedFact[]> {
    const { facts } = input;
    const bootstrap = facts.length === 0;
    const cfg = ctx.config || ({} as ScenarioPlannerConfig);
    const includeWhy = true;

    // --- HUD: planning lifecycle
    try { ctx.hud('planning','Thinking…'); } catch {}

    // Harness centrally gates unanswered agent_question; planner assumes preconditions are satisfied

    // 1) Read current status pill
    const status = getLastStatus(facts) || 'initializing';

    // 2) Hold during 'working' (no tools/no nudges)
    // Harness gates status/turn; planner proceeds based on domain logic

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
      // Planning invoked post-terminal; log quietly, do not announce
      return ([{ type:'planner_error', code:'POST_TERMINAL_PLANNING', message:'Planner invoked after terminal status', stage:'decision', attempts:0, announce:false } as any] as ProposedFact[]);
    }

    // Past this point: status is typically 'input-required' or 'canceled'/'failed'
    if (status === 'failed' || status === 'canceled') {
      return ([{ type:'planner_error', code:'POST_TERMINAL_PLANNING', message:`Planner invoked with status=${status}`, stage:'decision', attempts:0, announce:false } as any] as ProposedFact[]);
    }

    // 4) Multi-step loop with single-batch output
    try { ctx.hud('reading','Preparing prompt'); } catch {}
    const scenario = cfg.scenario;
    const myId = cfg.myAgentId || scenario?.agents?.[0]?.agentId || 'planner';
    const counterpartId = (scenario?.agents?.find(a => a.agentId !== myId)?.agentId) || (scenario?.agents?.[1]?.agentId) || 'counterpart';
    const allowSendToRemote = (status === 'input-required') || bootstrap;
    const enabledScenarioTools = Array.isArray((ctx.config as any)?.enabledTools) ? (ctx.config as any).enabledTools as string[] : undefined;
    // Default core tools omit sleep and principal messaging unless explicitly enabled
    const coreAllowed = new Set<string>(Array.isArray(cfg.enabledCoreTools) && cfg.enabledCoreTools.length
      ? cfg.enabledCoreTools
      : ['sendMessageToRemoteAgent','readAttachment','done']);
    const model = ctx.model;
    const maxSteps = Math.max(1, Math.min(50, Number(cfg.maxInlineSteps ?? 20)));

    const out: ProposedFact[] = [];
    const workingFacts: any[] = [...facts];
    const extra = (cfg as any)?.instructions;
    const sysContent = String(SYSTEM_PREAMBLE)
      + (typeof extra === 'string' && extra.trim() ? `\n<IMPORTANT_INSTRUCITOSM>\n${extra.trim()}\n</IMPORTANT_INSTRUCITOSM>\n` : '');
    const sys: LlmMessage = { role: 'system', content: sysContent };

    for (let step = 0; step < maxSteps; step++) {
      let prompt: string;
      let xmlHistory: string = '';
      try {
        const filesAtCut = listAttachmentMetasAtCut(workingFacts as any);
        xmlHistory = buildXmlHistory(workingFacts as any, myId, counterpartId);
        const availableFilesXml = buildAvailableFilesXml(filesAtCut);
        const toolsCatalog = buildToolsCatalog(scenario, myId, { allowSendToRemote }, enabledScenarioTools, Array.from(coreAllowed));
        const finalizationReminder = buildFinalizationReminder(workingFacts as any, scenario, myId) || undefined;
        prompt = buildPlannerPrompt(scenario, myId, counterpartId, xmlHistory, availableFilesXml, toolsCatalog, finalizationReminder);
      } catch (e:any) {
        const errMsg = String(e?.message || e || 'prompt build error');
        out.push(({ type:'planner_error', code:'PROMPT_BUILD_FAILED', message:'Prompt build failed', detail: errMsg, stage:'drafter', attempts:1, announce:true } as any));
        const humanMsg = 'We hit a temporary error while preparing your next step. Please reply or try again.';
        out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text: humanMsg, nextStateHint:'working' } as ProposedFact));
        break;
      }

    try {
      let lastCallId: string | null = null; let whyBody: string | undefined; let tName: string | undefined;
      for (let i = (workingFacts as any[]).length - 1; i >= 0; i--) { const f:any = workingFacts[i]; if (f?.type === 'tool_result') { lastCallId = String(f.callId||''); if (typeof f.why === 'string' && f.why.trim()) whyBody = f.why.trim(); break; } }
      if (lastCallId) { for (let j = (workingFacts as any[]).length - 1; j >= 0; j--) { const f:any = workingFacts[j]; if (f?.type === 'tool_call' && String(f.callId||'') === lastCallId) { tName = String(f.name||'tool'); break; } } }
      if (tName) ctx.hud('planning', `Thinking about ${tName} result`, whyBody);
      else ctx.hud('planning', buildThinkingHudLabel(facts as any) || 'Thinking…');
    } catch {}
      let decision: ParsedDecision;
      try {
        // Build allowed tools for semantic validation
        const allowedCore = Array.from(coreAllowed);
        const me = (scenario?.agents || []).find(a => a.agentId === myId) || scenario?.agents?.[0];
        const scenTools = ((me?.tools || []) as any[]).map(t=>String(t.toolName||''));
        const allowed = new Set<string>([...allowedCore, ...scenTools]);
        decision = await chatForDecisionWithRetry(ctx, { model, sys, prompt, validate: (d) => {
          const tool = String(d.tool||'').trim();
          if (!allowed.has(tool)) throw new Error(`DISALLOWED_ACTION:${tool}`);
          if ((tool === 'askUser' || tool === 'ask_user') && !String(d.args?.prompt||'').trim()) throw new Error('INVALID_ARGS:askUser.prompt');
          if (tool === 'sendMessageToMyPrincipal' && !String(d.args?.text||'').trim()) throw new Error('INVALID_ARGS:sendMessageToMyPrincipal.text');
          if (tool === 'readAttachment' || tool === 'read_attachment') {
            if (!String(d.args?.name||'').trim()) throw new Error('INVALID_ARGS:readAttachment.name');
          }
          if (tool === 'sendMessageToRemoteAgent') {
            const attList = Array.isArray(d.args?.attachments) ? d.args.attachments : [];
            const filesNow = listAttachmentMetasAtCut(workingFacts as any);
            const known = new Set(filesNow.map(a => a.name));
            const missing = attList.map((a:any)=>String(a?.name||'').trim()).filter((n:string)=>!!n && !known.has(n));
            if (missing.length) throw new Error(`MISSING_ATTACHMENT:${missing.join(',')}`);
          }
        }});
      } catch (e:any) {
        const emsg = String(e?.message || 'planner error');
        let code: any = 'LLM_PARSE_FAILED';
        if (/^DISALLOWED_ACTION/.test(emsg)) code = 'DISALLOWED_ACTION';
        else if (/^INVALID_ARGS/.test(emsg)) code = 'INVALID_ARGS';
        else if (/^MISSING_ATTACHMENT/.test(emsg)) code = 'MISSING_ATTACHMENT';
        const attemptsRaw = Array.isArray((e as any)?.attempts) ? (e as any).attempts as Array<any> : [];
        const trunc = (s: string, n = 300) => {
          try { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t; } catch { return ''; }
        };
        const allowedCore = Array.from(coreAllowed);
        const me = (scenario?.agents || []).find(a => a.agentId === myId) || scenario?.agents?.[0];
        const scenTools = ((me?.tools || []) as any[]).map(t=>String(t.toolName||''));
        const allowed = Array.from(new Set<string>([...allowedCore, ...scenTools]));
        const detail = {
          error: emsg,
          model,
          promptChars: (prompt || '').length,
          allowedActions: allowed,
          attempts: attemptsRaw.map((r:any) => ({
            attempt: Number(r?.attempt || 0),
            error: String(r?.error || ''),
            rawLen: (typeof r?.raw === 'string') ? r.raw.length : 0,
            cleanedLen: (typeof r?.cleaned === 'string') ? r.cleaned.length : 0,
            rawSnippet: trunc(String(r?.raw || '')),
            cleanedSnippet: trunc(String(r?.cleaned || '')),
          })),
        };
        out.push(({ type:'planner_error', code, message:'Planner could not produce a valid action after retries', stage:'decision', attempts:3, announce:true, detail } as any));
        const msg = `We encountered a drafting error and couldn’t proceed. Please respond so we can continue.`;
        out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text: msg, nextStateHint: 'working', ...(includeWhy ? { why:'Planner error after 3 attempts.' } : {}) } as ProposedFact));
        break;
      }
      const reasoning = decision.reasoning || 'Planner step.';

      // Dispatch
      if (decision.tool === 'sleep') {
        out.push(({ type:'planner_error', code:'DISALLOWED_ACTION', message:'Model chose disallowed action: sleep', stage:'decision', attempts:3, announce:true } as any));
        out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text: 'We encountered a drafting error and couldn’t proceed. Please respond so we can continue.', nextStateHint:'working' } as ProposedFact));
        break;
      }

      if (decision.tool === 'sendMessageToMyPrincipal') {
        if (!coreAllowed.has('sendMessageToMyPrincipal')) { out.push(({ type:'planner_error', code:'TOOL_DISABLED', message:'Tool disabled: sendMessageToMyPrincipal', stage:'decision', attempts:3, announce:true } as any)); out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text:'We encountered a drafting error and couldn’t proceed. Please respond so we can continue.', nextStateHint:'working' } as ProposedFact)); break; }
        const promptText = String(decision.args?.text || '').trim();
        if (!promptText) { out.push(({ type:'planner_error', code:'INVALID_ARGS', message:'Empty text for sendMessageToMyPrincipal', stage:'decision', attempts:3, announce:true } as any)); out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text:'We encountered a drafting error and couldn’t proceed. Please respond so we can continue.', nextStateHint:'working' } as ProposedFact)); break; }
        out.push(({ type:'agent_question', qid: ctx.newId('q:'), prompt: promptText, required:false, ...(includeWhy ? { why: reasoning } : {}) } as ProposedFact));
        break;
      }

      if (decision.tool === 'askUser' || decision.tool === 'ask_user') {
        const promptText = String(decision.args?.prompt || '').trim();
        if (!promptText) { out.push(({ type:'planner_error', code:'INVALID_ARGS', message:'Empty prompt for askUser', stage:'decision', attempts:3, announce:true } as any)); out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text:'We encountered a drafting error and couldn’t proceed. Please respond so we can continue.', nextStateHint:'working' } as ProposedFact)); break; }
        out.push(({ type:'agent_question', qid: ctx.newId('q:'), prompt: promptText, required: !!decision.args?.required, placeholder: typeof decision.args?.placeholder === 'string' ? decision.args.placeholder : undefined, ...(includeWhy ? { why: reasoning } : {}) } as ProposedFact));
        break;
      }

      if (decision.tool === 'readAttachment' || decision.tool === 'read_attachment') {
        if (!coreAllowed.has('readAttachment')) { out.push(sleepFact('Core tool disabled: readAttachment', includeWhy)); break; }
        const name = String(decision.args?.name || '').trim();
        const callId = ctx.newId('call:read');
        try { ctx.hud('tool', 'read_attachment', { name: name || '?' }); } catch {}
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
        if (!coreAllowed.has('done')) { out.push(({ type:'planner_error', code:'TOOL_DISABLED', message:'Tool disabled: done', stage:'decision', attempts:3, announce:false } as any)); }
        else {
          const text = 'We have completed this request.';
          out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text, nextStateHint: 'completed', ...(includeWhy ? { why: reasoning } : {}) } as ProposedFact));
        }
        break;
      }

      if (decision.tool === 'sendMessageToRemoteAgent') {
        if (!coreAllowed.has('sendMessageToRemoteAgent')) { out.push(sleepFact('Core tool disabled: sendMessageToRemoteAgent', includeWhy)); break; }
        const attList = Array.isArray(decision.args?.attachments) ? decision.args.attachments : [];
        const filesNow = listAttachmentMetasAtCut(workingFacts as any);
        const known = new Set(filesNow.map(a => a.name));
        const missing = attList.map((a:any)=>String(a?.name||'').trim()).filter((n:string)=>!!n && !known.has(n));
        if (missing.length) { out.push(({ type:'planner_error', code:'MISSING_ATTACHMENT', message:`Attachments missing: ${missing.join(', ')}`, detail:{ missing }, stage:'decision', attempts:3, announce:true } as any)); out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text:`We need the following attachment(s) to proceed: ${missing.join(', ')}.`, nextStateHint:'working' } as ProposedFact)); break; }
        const composeId = ctx.newId('c:');
        const text = String(decision.args?.text || '').trim() || defaultComposeFromScenario(scenario, myId);
        const metaList: AttachmentMeta[] = attList.map((a:any)=>String(a?.name||'')).filter(Boolean).map((name:string)=>({ name, mimeType: filesNow.find(x=>x.name===name)?.mimeType || 'application/octet-stream' }));
          out.push(({ type:'compose_intent', composeId, text, attachments: metaList.length ? metaList : undefined, ...(includeWhy ? { why: reasoning } : {}), nextStateHint: (buildFinalizationReminder(workingFacts as any, scenario, myId) ? 'completed' : 'working') } as ProposedFact));
        try { ctx.hud('drafting', 'Prepared draft'); } catch {}
        break;
      }

      // Scenario tool name
      if (enabledScenarioTools && !enabledScenarioTools.includes(decision.tool)) { out.push(({ type:'planner_error', code:'TOOL_DISABLED', message:`Tool disabled: ${decision.tool}`, stage:'decision', attempts:3, announce:true } as any)); out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text:'We encountered a drafting error and couldn’t proceed. Please respond so we can continue.', nextStateHint:'working' } as ProposedFact)); break; }
      const tdef = findScenarioTool(scenario, myId, decision.tool);
      if (!tdef) { out.push(({ type:'planner_error', code:'TOOL_UNKNOWN', message:`Unknown tool: ${decision.tool}`, stage:'decision', attempts:3, announce:true } as any)); out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text:'We encountered a drafting error and couldn’t proceed. Please respond so we can continue.', nextStateHint:'working' } as ProposedFact)); break; }

      const callId = ctx.newId(`call:${decision.tool}:`);
      try { ctx.hud('tool', String(decision.tool), decision.args || {}); } catch {}
      out.push(({ type:'tool_call', callId, name: decision.tool, args: decision.args || {}, ...(includeWhy ? { why: reasoning } : {}) } as ProposedFact));
      const existingNamesAtCallStart = (() => {
        const s = new Set<string>();
        for (const f of workingFacts as any[]) { if (f?.type === 'attachment_added' && f.name) s.add(String(f.name)); }
        for (const f of facts as any[]) { if (f?.type === 'attachment_added' && f.name) s.add(String(f.name)); }
        return Array.from(s);
      })();
      const exec = await runToolOracle({ tool: tdef, args: decision.args || {}, scenario, myAgentId: myId, conversationHistory: xmlHistory, leadingThought: reasoning, llm: ctx.llm, model, existingNames: existingNamesAtCallStart });
      if (!exec.ok) {
        const emsg = String(exec.error || 'Tool failed');
        out.push(({ type:'tool_result', callId, ok:false, error: emsg, ...(includeWhy ? { why:'Tool execution error.' } : {}) } as ProposedFact));
        out.push(({ type:'planner_error', code:'TOOL_EXEC_FAILED', message:`Tool execution error: ${emsg}`, stage:'tool', attempts:3, announce:true, relatesTo:{ callId, tool: tdef.toolName }, detail: { error: emsg } } as any));
        out.push(({ type:'compose_intent', composeId: ctx.newId('c:'), text:'We encountered an error while running a tool. Please respond so we can continue.', nextStateHint:'working' } as ProposedFact));
        break;
      }
      // Stamp the oracle's reasoning onto the tool_result so downstream UI and HUD can reflect it
      out.push(({ type:'tool_result', callId, ok:true, result: exec.result ?? null, ...(includeWhy ? { why: exec.reasoning || 'Tool execution succeeded.' } : {}) } as ProposedFact));
      // Filter duplicate attachments by name to keep the journal clean
      const existingNames = new Set<string>();
      for (const f of workingFacts as any[]) { if (f?.type === 'attachment_added' && f.name) existingNames.add(String(f.name)); }
      for (const f of facts as any[]) { if (f?.type === 'attachment_added' && f.name) existingNames.add(String(f.name)); }
      const newAttachments = exec.attachments.filter(a => a?.name && !existingNames.has(String(a.name)));
      for (const doc of newAttachments) {
        out.push(({ type:'attachment_added', name: doc.name, mimeType: doc.mimeType, bytes: doc.bytesBase64, origin:'synthesized', producedBy:{ callId, name: tdef.toolName, args: decision.args || {} }, ...(includeWhy ? { why:'Synthesized by scenario tool.' } : {}) } as ProposedFact));
        existingNames.add(String(doc.name));
      }
      // Update working facts
      workingFacts.push({ type:'tool_call', callId, name: decision.tool, args: decision.args || {} } as any);
      // Also carry reasoning into the ephemeral working facts to drive HUD between steps
      workingFacts.push({ type:'tool_result', callId, ok:true, result: exec.result ?? null, why: exec.reasoning } as any);
      // After recording the working fact, set HUD for the follow-up planning step
      try {
        let why = '';
        for (let i = workingFacts.length - 1; i >= 0; i--) {
          const f: any = workingFacts[i];
          if (f && f.type === 'tool_result' && String(f.callId||'') === callId) { if (typeof f.why === 'string' && f.why.trim()) why = f.why.trim(); break; }
        }
        if (why) ctx.hud('planning', `Thinking about ${tdef.toolName} result`, why);
      } catch {}
      for (const doc of newAttachments) workingFacts.push({ type:'attachment_added', name: doc.name, mimeType: doc.mimeType, bytes: doc.bytesBase64, origin:'synthesized', producedBy:{ callId, name: tdef.toolName } } as any);
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
You are a turn-based agent planner.
Always respond with exactly one JSON object containing keys "reasoning" and "action".
No extra commentary, prose, or code fences.
`;

type ParsedDecision = { reasoning: string; tool: string; args: any };

function shortArgs(a: any): string {
  try {
    // Return full JSON so the HUD can parse and pretty-print below; no truncation/ellipsis.
    return JSON.stringify(a ?? {});
  } catch { return ''; }
}

// Centralized wrapper: retry up to 3x until a valid decision JSON is parsed.
// Captures per-attempt raw output and validation errors for diagnostics.
async function chatForDecisionWithRetry(ctx: PlanContext<any>, opts: { model?: string; sys: LlmMessage; prompt: string; validate?: (d: ParsedDecision) => void }): Promise<ParsedDecision> {
  const attempts = 3;
  const attemptLog: Array<{ attempt: number; raw: string; cleaned: string; error?: string }> = [];
  let lastErr: any = null;
  for (let i = 1; i <= attempts; i++) {
    const req: { model?: string; messages: LlmMessage[]; temperature?: number; signal?: AbortSignal } = {
      model: opts.model,
      messages: [opts.sys, { role: 'user', content: opts.prompt }],
      temperature: 0.5,
      signal: ctx.signal,
    };
    try {
      const { text } = await ctx.llm.chat(req);
      const cleaned = cleanModelText(text);
      const d = parseActionStrict(cleaned);
      try { opts.validate && opts.validate(d); } catch (e:any) { throw e; }
      return d;
    } catch (e:any) {
      const raw = (() => {
        try { return String((e && e.text) ? e.text : ''); } catch { return ''; }
      })();
      const cleaned = (() => { try { return cleanModelText(raw); } catch { return ''; } })();
      attemptLog.push({ attempt: i, raw, cleaned, error: String(e?.message || e) });
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (i < attempts) {
        const delay = 150 * Math.pow(2, i - 1) + Math.floor(Math.random() * 30);
        await new Promise(res => setTimeout(res, delay));
      }
    }
  }
  (lastErr as any).attempts = attemptLog;
  throw lastErr;
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
    if (f.type === 'message_sent') {
      // Planner → counterpart
      lines.push(`<message from="${me}" to="${other}">`);
      if (f.text) lines.push(escapeXml(f.text));
      for (const a of f.attachments || []) lines.push(`<attachment name="${a.name}" mimeType="${a.mimeType}" />`);
      lines.push(`</message>`);
    } else if (f.type === 'message_received') {
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
          // Support unified schema (contentString/contentJson) and legacy content/text
          const bodyStr = (() => {
            if (typeof d?.contentString === 'string') return d.contentString as string;
            if (d && typeof d?.contentJson !== 'undefined') try { return JSON.stringify(d.contentJson, null, 2); } catch { return String(d.contentJson); }
            if (typeof d?.content === 'string') return d.content as string;
            if (d && typeof d?.content === 'object' && d?.contentType && String(d.contentType).includes('json')) {
              try { return JSON.stringify(d.content, null, 2); } catch { return String(d.content); }
            }
            if (typeof d?.text === 'string') return d.text as string;
            return undefined;
          })();
          if (name && typeof bodyStr === 'string' && bodyStr) {
            // Do not XML-escape: tags are used as simple delimiters only
            lines.push(`<tool_result filename="${name}">\n${bodyStr}\n</tool_result>`);
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

function indentBlock(s: string, spaces = 2): string {
  const pad = ' '.repeat(Math.max(0, spaces));
  return String(s || '')
    .split('\n')
    .map(line => (line ? pad + line : ''))
    .join('\n');
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

  // If any message_sent happened after this call, no reminder needed
  for (let i = facts.length - 1; i > lastIdx; i--) {
    const f = facts[i];
    if (f.type === 'message_sent') return null;
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

  // Default core tools omit sleep and principal messaging unless explicitly enabled
  const coreAllowed = new Set<string>(Array.isArray(enabledCoreTools) && enabledCoreTools.length
    ? enabledCoreTools
    : ['sendMessageToRemoteAgent','readAttachment','done']);
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
  if (t === 'array') return `Array<${schemaToTs(schema?.items, indent + 1)}>`;
  if (t === 'object' || (schema && (schema as any).properties)) {
    const props = (schema && (schema as any).properties) || {};
    const req: string[] = Array.isArray(schema?.required) ? (schema as any).required : [];
    const parts: string[] = ['{'];
    for (const k of Object.keys(props)) {
      const opt = req.includes(k) ? '' : '?';
      parts.push(`${'  '.repeat(indent + 1)}${k}${opt}: ${schemaToTs((props as any)[k], indent + 1)};`);
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
  reasoning?: string;
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
  existingNames?: ReadonlyArray<string>;
}): Promise<OracleExec> {
  const prompt = buildOraclePromptAligned(opts);
  try {
    const req = { model: opts.model, messages: [{ role: 'user', content: prompt }], temperature: 0.6 } as const;
    const parsed = await chatWithValidationRetry(opts.llm, req as any, (text) => parseOracleResponseAligned(text), { attempts: 3 });
    const { output, reasoning } = parsed;
    const { attachments, result } = await extractAttachmentsFromOutput(output, opts.tool.toolName, opts.args, new Set(opts.existingNames || []));
    return { ok: true, result, attachments, reasoning };
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
    'Return exactly one JSON code block with keys:',
    '- reasoning: string',
    '- output: { documents: Document[] }',
    '',
    'Document shape:',
    '{',
    '  "docId"?: string,',
    '  "name": string,',
    '  "contentType": string,  // Allowed: application/json, text/plain, text/markdown, text/csv, application/xml, text/xml',
    '  "contentString"?: string,  // for text-like types (e.g., text/plain, text/markdown)',
    '  "contentJson"?: any,       // for application/json and other structured content',
    '  "summary"?: string',
    '}',
    'Rules:',
    '- Exactly one of contentString or contentJson must be present per document (never both).',
    '- Use contentJson only when contentType is application/json. For all other allowed types, use contentString.',
    '- Do NOT claim to produce binary formats (e.g., PDF, images, Word/Excel); this Oracle outputs text-only artifacts.',
    '- If a binary-like artifact is implied, instead provide a faithful text/markdown or JSON representation.',
    'Return multiple documents by including multiple entries in output.documents in the desired order.',
    '',
    'Example with two artifacts:',
    '```',
    '{',
    '  "reasoning": "Brief rationale.",',
    '  "output": {',
    '    "documents": [',
    '      {',
    '        "docId": "contract_123",',
    '        "name": "contract.json",',
    '        "contentType": "application/json",',
    '        "contentJson": { /* content here */ }',
    '      },',
    '      {',
    '        "docId": "interfaces_456",',
    '        "name": "interfaces.txt",',
    '        "contentType": "text/plain",',
    '        "contentString": "<content here>"',
    '      }',
    '    ]',
    '  }',
    '}',
    '```',
    '</OUTPUT_FORMATS>'
  ].join('\n');

  const constraints = [
    '<CONSTRAINTS>',
    '- The conversation thread is the sole channel of exchange.',
    '- Do NOT suggest portals, emails, fax, or separate submission flows.',
    '- Encourage sharing documents via conversation attachments (by docId) when appropriate.',
    '- Reveal only what the specific tool would plausibly know, even though you are omniscient.',
    '- Text-only artifacts only: do NOT produce binary formats (e.g., PDF, images, Office documents).',
    '</CONSTRAINTS>'
  ].join('\n');

  const outputContract = [
    '<OUTPUT_CONTRACT>',
    '- Return exactly one framing JSON code block.',
    '- The framing JSON MUST have keys: "reasoning" (string) and "output" (with a "documents" array as specified above).',
    '- No extra text outside the code block.',
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
  // directors note is included only in RESULT_FORMAT below to avoid duplication
  // Explicit synthesis guidance
  lines.push('<SYNTHESIS_GUIDANCE>');
  lines.push('- Action focus: Use the tool name and the provided arguments as the primary source of truth. Produce the best possible result that this tool would return for those arguments.');
  lines.push('- Context use: Conversation history and agent thought may inform realism and details, but do not invent unrelated outputs. Stay aligned with the tool’s role and its inputs.');
  lines.push('- Move forward: If inputs are insufficient to progress, include concise next-step suggestions in the document "summary" field (e.g., needed fields and one concrete next action).');
  lines.push('- Scope discipline: Do not switch tools or simulate other systems. Only return what this tool would produce.');
  lines.push('- Clarity and brevity: Prefer concise, well-structured content. Avoid narrative filler beyond the requested artifacts.');
  lines.push('</SYNTHESIS_GUIDANCE>');
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
  lines.push('<RESULT_FORMAT>');
  lines.push(`Produce your response to the "${tool.toolName}" tool call with the args shown above.`);
  lines.push('');
  lines.push('<DIRECTORS_NOTE_GUIDING_RESULTS>');
  lines.push(indentBlock(directorsNote));
  lines.push('</DIRECTORS_NOTE_GUIDING_RESULTS>');
  lines.push('');
  lines.push('</RESULT_FORMAT>');
  lines.push('');
  lines.push('Follow SYNTHESIS_GUIDANCE and DIRECTORS_NOTE_GUIDING_RESULTS, and OUTPUT_CONTRACT exactly.');
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

export function parseOracleResponseAligned(content: string): { reasoning: string; output: unknown } {
  const parseWithRescue = (s: string): any => {
    const obj = tryParseJson(s);
    if (obj !== null) return obj;
    const rescued = rescueJsonStructure(s);
    const obj2 = tryParseJson(rescued);
    if (obj2 !== null) return obj2;
    throw new Error('Invalid JSON (after rescue attempt)');
  };

  // Prefer ```json fenced block
  const jsonBlock = content.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlock?.[1]) {
    const obj = parseWithRescue(jsonBlock[1]);
    if (obj && typeof obj.reasoning === 'string' && 'output' in obj) return { reasoning: obj.reasoning, output: (obj as any).output };
    throw new Error('JSON block missing required keys { reasoning, output }');
  }
  // Generic ``` fenced block
  const codeBlock = content.match(/```\s*([\s\S]*?)\s*```/);
  if (codeBlock?.[1]) {
    const obj = parseWithRescue(codeBlock[1]);
    if (obj && typeof obj.reasoning === 'string' && 'output' in obj) return { reasoning: obj.reasoning, output: (obj as any).output };
    throw new Error('Code block missing required keys { reasoning, output }');
  }
  // First bare JSON object in the content
  const bare = extractFirstJsonObjectAligned(content);
  if (bare) {
    const obj = parseWithRescue(bare);
    if (obj && typeof obj.reasoning === 'string' && 'output' in obj) return { reasoning: obj.reasoning, output: (obj as any).output };
    throw new Error('Bare JSON missing required keys { reasoning, output }');
  }
  throw new Error('No JSON object found in Oracle response');
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

function heuristicParseAligned(_content: string): { reasoning: string; output: unknown } | null { return null; }

function rescueJsonStructure(s: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  let inString = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out.push(ch);
    if (esc) { esc = false; continue; }
    if (ch === '\\') { if (inString) esc = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      const need = ch === '}' ? '{' : '[';
      while (stack.length && stack[stack.length - 1] !== need) {
        const top = stack.pop()!;
        out.splice(out.length - 1, 0, top === '[' ? ']' : '}');
      }
      if (stack.length && stack[stack.length - 1] === need) stack.pop();
    }
  }
  while (stack.length) {
    const top = stack.pop()!;
    out.push(top === '[' ? ']' : '}');
  }
  return out.join('');
}

async function extractAttachmentsFromOutput(
  output: unknown,
  toolName?: string,
  toolArgs?: Record<string, unknown>,
  existingNamesInput?: ReadonlySet<string>
): Promise<{ attachments: Array<{ name: string; mimeType: string; bytesBase64: string }>; result: unknown }>
{
  const attachments: Array<{ name: string; mimeType: string; bytesBase64: string }> = [];
  const assigned = new Set<string>(Array.from(existingNamesInput || []));

  // Collect candidate document objects (by reference) so we can rewrite names.
  const candidates: Array<{ ref: any; name: string; mimeType: string; content: string }> = [];
  const collectDoc = (d: any) => {
    if (!d || typeof d !== 'object') return;
    const name = String(d?.name || '').trim();
    const contentType = String(d?.contentType || 'text/markdown');
    const contentString: string | undefined = typeof d?.contentString === 'string' ? d.contentString
      : (typeof d?.content === 'string' ? d.content : (d?.document && typeof d.document.content === 'string' ? d.document.content : undefined));
    const contentJson: any = (d && typeof d === 'object' && 'contentJson' in d) ? (d as any).contentJson : undefined;
    let materialized: string | undefined = undefined;
    if (typeof contentString === 'string') {
      materialized = contentString;
    } else if (typeof contentJson !== 'undefined') {
      try { materialized = JSON.stringify(contentJson, null, 2); } catch { materialized = String(contentJson); }
    } else if (d && typeof d?.content === 'object' && contentType && String(contentType).includes('json')) {
      try { materialized = JSON.stringify(d.content, null, 2); } catch { materialized = String(d.content); }
    }
    if (name && typeof materialized === 'string' && materialized) {
      candidates.push({ ref: d, name, mimeType: contentType, content: materialized });
    }
  };
  try {
    if (output && typeof output === 'object') {
      // Direct document output
      if ((output as any).docId || (output as any).name) collectDoc(output);
      // Nested document field
      if ((output as any).document) collectDoc((output as any).document);
      // Legacy documents array
      const docs = (output as any).documents;
      if (Array.isArray(docs)) for (const d of docs) collectDoc(d);

      // If we found explicit docs, uniquify names and build attachments
      for (const c of candidates) {
        const finalName = uniqueName(c.name, assigned);
        assigned.add(finalName);
        try { if (c.ref && typeof c.ref === 'object') c.ref.name = finalName; } catch {}
        attachments.push({ name: finalName, mimeType: c.mimeType, bytesBase64: toBase64(c.content) });
      }

      // Fallback: if no explicit docs were found, attach the entire JSON output
      if (!attachments.length) {
        const json = stableJson(output);
        const base = buildJsonAttachmentBase(toolName, toolArgs, 64);
        const short = await shortHash6(json);
        const desired = `${base}-${short}.json`;
        const finalName = uniqueName(desired, assigned);
        assigned.add(finalName);
        attachments.push({ name: finalName, mimeType: 'application/json', bytesBase64: toBase64(json) });
      }
    }
  } catch {}
  return { attachments, result: output };
}

function safeStringify(v: unknown): string { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function stableJson(v: unknown): string {
  try {
    const seen = new WeakSet();
    const replacer = (_key: string, value: any) => {
      if (value && typeof value === 'object') {
        if (seen.has(value)) return undefined;
        seen.add(value);
        if (!Array.isArray(value)) {
          // sort object keys for stable output
          const obj: Record<string, any> = {};
          for (const k of Object.keys(value).sort()) obj[k] = value[k];
          return obj;
        }
      }
      return value;
    };
    return JSON.stringify(v, replacer, 2);
  } catch { return safeStringify(v); }
}
async function sha256Base64Url(s: string): Promise<string> {
  try {
    const enc = new TextEncoder().encode(s);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const digest = await (globalThis.crypto?.subtle?.digest?.('SHA-256', enc));
    if (digest) {
      const bytes = new Uint8Array(digest);
      let b64 = '';
      for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const raw = btoa(b64);
      return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
    }
  } catch {}
  // Fallback: base64 of input (not cryptographic) if SubtleCrypto unavailable
  return toBase64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
}
async function shortHash6(s: string): Promise<string> {
  try {
    const full = await sha256Base64Url(s);
    const alnum = full.replace(/[^A-Za-z0-9]/g, '');
    const six = alnum.slice(0, 6);
    if (six.length === 6) return six;
    return (alnum + '000000').slice(0, 6);
  } catch { return '000000'; }
}
function buildJsonAttachmentBase(toolName?: string, toolArgs?: Record<string, unknown>, maxLen = 64): string {
  const tn = String(toolName || 'tool');
  let argsStr = '';
  try { argsStr = stableJson(toolArgs || {}); } catch {}
  const mashed = `${tn}-${argsStr}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return mashed.length <= maxLen ? mashed : mashed.slice(0, maxLen);
}
function truncateText(s: string, max: number, suffix = '...'): string {
  if (!s) return s;
  if (s.length <= max) return s;
  if (max <= suffix.length) return s.slice(0, max);
  return s.slice(0, max - suffix.length) + suffix;
}

// -----------------------------
// HUD helpers for "thinking" label
// -----------------------------

function buildThinkingHudLabel(facts: ReadonlyArray<Fact>): string | null {
  const why = lastReasoning(facts);
  const whyShort = why ? truncateText(oneLine(why), 80) : '';
  // If we have explicit reasoning, show that alone.
  if (whyShort) return `Thinking about: ${whyShort}`;
  const tool = describeLastToolContext(facts);
  if (tool) return `Thinking: ${truncateText(tool, 80)}`;
  // Fallback to last inbound/outbound line
  const msg = lastMessageLine(facts);
  if (msg) return `Thinking about: ${truncateText(msg, 80)}`;
  return null;
}


function describeLastToolContext(facts: ReadonlyArray<Fact>): string | null {
  // Find latest tool_result
  let idx = -1;
  for (let i = facts.length - 1; i >= 0; i--) { if (facts[i].type === 'tool_result') { idx = i; break; } }
  if (idx < 0) return null;
  const tr = facts[idx] as any;
  const callId = String(tr.callId || '');
  const ok = tr.ok !== false;
  // Find associated tool_call for name
  let toolName: string | null = null;
  for (let j = idx - 1; j >= 0; j--) {
    const f = facts[j] as any;
    if (f.type === 'tool_call' && String(f.callId || '') === callId) { toolName = String(f.name || 'tool'); break; }
  }
  const result = tr.result;
  if (!ok) {
    const err = String(tr.error || 'error');
    return `${toolName || 'tool'} — error: ${err}`;
  }
  // Document-like results
  try {
    const docs: any[] = Array.isArray(result?.documents) ? result.documents : [];
    const single = (result && typeof result === 'object' && (result.name || result.docId)) ? [result] : [];
    const all = (docs.length ? docs : single) as any[];
    if (all.length) {
      const names = all.map(d => String(d?.name || d?.docId || 'result')).filter(Boolean);
      if (names.length === 1) return `${toolName || 'tool'} — ${names[0]}`;
      if (names.length > 1) return `${toolName || 'tool'} — ${names[0]}, +${names.length - 1}`;
    }
    // Text content (e.g., read_attachment inline embedding or single doc with text)
    const text: string | undefined = (typeof (result as any)?.text === 'string') ? (result as any).text
      : (typeof (result as any)?.content === 'string') ? (result as any).content
      : undefined;
    if (typeof text === 'string' && text.trim()) {
      const first = firstLine(text);
      // If read_attachment, try to include filename when present
      const name = (result as any)?.name;
      if (name) return `read ${String(name)} — ${first}`;
      return `${toolName || 'tool'} — ${first}`;
    }
  } catch {}
  return toolName || 'tool';
}

function lastReasoning(facts: ReadonlyArray<Fact>): string | null {
  for (let i = facts.length - 1; i >= 0; i--) {
    const f: any = facts[i];
    if (typeof f?.why === 'string' && f.why.trim()) return f.why.trim();
    if (f?.type === 'sleep' && typeof f?.reason === 'string' && f.reason.trim()) return f.reason.trim();
  }
  return null;
}

function lastMessageLine(facts: ReadonlyArray<Fact>): string | null {
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i] as any;
    if (f.type === 'message_received' || f.type === 'message_sent') {
      const t = String(f.text || '').trim();
      if (t) return firstLine(t);
    }
  }
  return null;
}

function firstLine(s: string): string { const i = s.indexOf('\n'); const line = i >= 0 ? s.slice(0, i) : s; return line.trim(); }
function oneLine(s: string): string { return String(s || '').replace(/\s+/g, ' ').trim(); }

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
