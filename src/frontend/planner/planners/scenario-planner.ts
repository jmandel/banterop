// src/frontend/planner/planners/scenario-planner.ts
//
// Scenario-aware planner for v0.3 Planner API.
// Core behaviors ported from the older ScenarioPlanner:
//  - Hold during 'working' (emit sleep only)
//  - Only propose remote messaging when status === 'input-required' (or initial kick-off if enabled)
//  - Exactly one user wrap-up question after 'completed'
//  - Terminal tools: after endsConversation tool, auto-propose a compose with attachments
//
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
import type { ScenarioConfiguration, Tool as ScenarioTool } from '../../../types/scenario-configuration.types'; // ← adjust

// -----------------------------
// Public export
// -----------------------------

export interface ScenarioPlannerConfig {
  scenario: ScenarioConfiguration;

  /**
   * If true, the planner may initiate the conversation (propose a compose_intent)
   * when there is no prior remote/public traffic and the status allows it.
   * Default: false (conservative).
   */
  allowInitiation?: boolean;

  /** Optional model override; otherwise ctx.model is used. */
  model?: string;

  /** If true, include tool/event traces as short 'why' strings on planner facts. Default: true. */
  includeWhy?: boolean;
}

export const ScenarioPlannerV03: Planner<ScenarioPlannerConfig> = {
  id: 'scenario-v0.3',
  name: 'Scenario Planner (v0.3)',

  async plan(input: PlanInput, ctx: PlanContext<ScenarioPlannerConfig>): Promise<ProposedFact[]> {
    const { facts } = input;
    const cfg = ctx.config || ({} as ScenarioPlannerConfig);
    const includeWhy = cfg.includeWhy !== false;

    // --- HUD: planning lifecycle
    ctx.hud('planning', 'Scanning state');

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

    // 4) Build prompt from scenario + history + tools catalogue
    ctx.hud('reading', 'Preparing prompt', 0.2);
    const scenario = cfg.scenario;
    const myId = ctx.myAgentId || scenario?.agents?.[0]?.agentId || 'planner';
    const counterpartId = ctx.otherAgentId || (scenario?.agents?.find(a => a.agentId !== myId)?.agentId ?? 'counterpart');

    const filesAtCut = listAttachmentMetasAtCut(facts);
    const xmlHistory = buildXmlHistory(facts, myId, counterpartId);
    const availableFilesXml = buildAvailableFilesXml(filesAtCut);

    const toolsCatalog = buildToolsCatalog(scenario, {
      allowSendToRemote: status === 'input-required',
    });

    const prompt = buildPlannerPrompt(scenario, myId, counterpartId, xmlHistory, availableFilesXml, toolsCatalog);

    // 5) Ask LLM for exactly one action
    ctx.hud('planning', 'Choosing next tool');
    const sys: LlmMessage = { role: 'system', content: SYSTEM_PREAMBLE };
    const user: LlmMessage = { role: 'user', content: prompt };
    const model = cfg.model || ctx.model;
    const { text: llmText } = await ctx.llm.chat({ model, messages: [sys, user], temperature: 0.2, maxTokens: 800, signal: ctx.signal });

    const decision = parseAction(llmText);
    const reasoning = decision.reasoning || 'Planner step.';

    // 6) Map chosen action to ProposedFacts[]
    switch (decision.tool) {
      case 'sleep': {
        return [sleepFact('LLM chose to sleep.', includeWhy, reasoning)];
      }

      case 'askUser':
      case 'ask_user': {
        const promptText = String(decision.args?.prompt || '').trim();
        const qid = ctx.newId('q:');
        if (!promptText) return [sleepFact('askUser: empty prompt → sleep', includeWhy, reasoning)];
        const q: ProposedFact = ({
          type: 'agent_question',
          qid,
          prompt: promptText,
          required: !!decision.args?.required,
          placeholder: typeof decision.args?.placeholder === 'string' ? decision.args.placeholder : undefined,
          ...(includeWhy ? { why: reasoning } : {})
        }) as ProposedFact;
        return [q];
      }

      case 'readAttachment':
      case 'read_attachment': {
        const name = String(decision.args?.name || '').trim();
        const callId = ctx.newId('call:read');
        const out: ProposedFact[] = [({
          type: 'tool_call',
          callId,
          name: 'read_attachment',
          args: { name },
          ...(includeWhy ? { why: reasoning } : {})
        }) as ProposedFact];

        if (name) {
          const rec = await ctx.readAttachment(name);
          if (rec) {
            // Starter: return a tiny excerpt only as tool_result (no synthesized attachment here).
            const textExcerpt = safeDecodeUtf8(rec.bytes, 2000);
            out.push(({
              type: 'tool_result',
              callId,
              ok: true,
              result: { name, mimeType: rec.mimeType, size: rec.bytes?.length ?? undefined, excerpt: textExcerpt },
              ...(includeWhy ? { why: 'Attachment available at cut.' } : {})
            }) as ProposedFact);
          } else {
            out.push(({
              type: 'tool_result',
              callId,
              ok: false,
              error: `Attachment '${name}' is not available at this Cut.`,
              ...(includeWhy ? { why: 'readAttachment failed.' } : {})
            }) as ProposedFact);
          }
        } else {
          out.push(({
            type: 'tool_result',
            callId,
            ok: false,
            error: 'Missing name',
            ...(includeWhy ? { why: 'readAttachment missing name.' } : {})
          }) as ProposedFact);
        }
        // Terminal
        out.push(sleepFact('readAttachment completed.', includeWhy));
        return out;
      }

      case 'sendMessageToRemoteAgent': {
        // Only when status === 'input-required' (toolsCatalog gated this)
        if (status !== 'input-required') {
          return [sleepFact('Not our turn to message remote.', includeWhy, reasoning)];
        }
        // Validate attachments exist at Cut
        const attList = Array.isArray(decision.args?.attachments) ? decision.args.attachments : [];
        const known = new Set(filesAtCut.map(a => a.name));
        const missing = attList.map((a: any) => String(a?.name || '').trim()).filter((n: string) => !!n && !known.has(n));
        if (missing.length) {
          return [sleepFact(`Attachments missing: ${missing.join(', ')}.`, includeWhy, reasoning)];
        }
        const composeId = ctx.newId('c:');
        const text = String(decision.args?.text || '').trim() || defaultComposeFromScenario(scenario, myId);
        const metaList: AttachmentMeta[] = attList
          .map((a: any) => String(a?.name || '').trim())
          .filter(Boolean)
          .map((name: string) => {
            // Try to recover the mimeType from ledger
            const mimeType = filesAtCut.find(a => a.name === name)?.mimeType || 'application/octet-stream';
            return { name, mimeType };
          });
        const pf: ProposedFact = ({
          type: 'compose_intent',
          composeId,
          text,
          attachments: metaList.length ? metaList : undefined,
          ...(includeWhy ? { why: reasoning } : {})
        }) as ProposedFact;
        return [pf];
      }

      default: {
        // Scenario tool?
        const toolName = decision.tool;
        const tdef = findScenarioTool(scenario, myId, toolName);
        if (!tdef) {
          return [sleepFact(`Unknown tool '${toolName}' → sleep.`, includeWhy, reasoning)];
        }
        // Hold tools if somehow not our turn (defensive, though we already gated earlier only on 'working')
        if (status !== 'input-required') {
          // We can *calculate* while remote is working, but your requirement says "hold tools during 'working'".
          // Here status is not 'working'; still, if you want, add more gating. We'll allow tool now.
        }

        // Execute tool via Oracle (LLM-synth), journal call/result and synthesized attachments
        const callId = ctx.newId(`call:${toolName}:`);
        const out: ProposedFact[] = [({
          type: 'tool_call',
          callId,
          name: toolName,
          args: decision.args || {},
          ...(includeWhy ? { why: reasoning } : {})
        }) as ProposedFact];

        ctx.hud('tool', `Executing ${toolName}`);
        const exec = await runToolOracle({
          tool: tdef,
          args: decision.args || {},
          scenario,
          myAgentId: myId,
          knowledgeBase: scenario?.agents?.find(a => a.agentId === myId)?.knowledgeBase,
          llm: ctx.llm,
          model: model
        });

        if (!exec.ok) {
          out.push(({
            type: 'tool_result',
            callId,
            ok: false,
            error: exec.error || 'Tool failed',
            ...(includeWhy ? { why: 'Tool execution error.' } : {})
          }) as ProposedFact);
          out.push(sleepFact('Tool error → sleeping.', includeWhy));
          return out;
        }

        // ok: attach synthesized docs if any
        out.push(({
          type: 'tool_result',
          callId,
          ok: true,
          result: exec.result ?? null,
          ...(includeWhy ? { why: 'Tool execution succeeded.' } : {})
        }) as ProposedFact);

        const introduced = new Set<string>();
        for (const doc of exec.attachments) {
          out.push(({
            type: 'attachment_added',
            name: doc.name,
            mimeType: doc.mimeType,
            bytes: doc.bytesBase64,
            origin: 'synthesized',
            producedBy: { callId, name: tdef.toolName, args: decision.args || {} },
            ...(includeWhy ? { why: 'Synthesized by scenario tool.' } : {})
          }) as ProposedFact);
          introduced.add(doc.name);
        }

        // If terminal tool, auto‑prep final compose (composer will open; harness can set finality=conversation on send)
        if (tdef.endsConversation) {
          const composeId = ctx.newId('c:');
          const attMeta: AttachmentMeta[] = exec.attachments.map(a => ({ name: a.name, mimeType: a.mimeType }));
          const text = finalComposeFromTerminal(exec, tdef, scenario, myId);
          out.push(({
            type: 'compose_intent',
            composeId,
            text,
            attachments: attMeta.length ? attMeta : undefined,
            ...(includeWhy ? { why: `Terminal tool '${tdef.toolName}' completed; send final response.` } : {})
          }) as ProposedFact);
          return out; // terminal fact already last
        }

        // Non-terminal tool: either ask user, propose a draft (if allowed), or sleep.
        // Honor your rule: remote messaging only when input-required.
        if (status === 'input-required') {
          const draft = draftComposeFromTool(exec, tdef, scenario, myId);
          if (draft) {
            out.push(({
              type: 'compose_intent',
              composeId: ctx.newId('c:'),
              text: draft.text,
              attachments: draft.attachments?.length ? draft.attachments : undefined,
              ...(includeWhy ? { why: `Proposed draft after '${tdef.toolName}'.` } : {})
            }) as ProposedFact);
            return out;
          }
        }

        out.push(sleepFact(`Finished '${tdef.toolName}' — awaiting next event.`, includeWhy));
        return out;
      }
    }
  }
};

// -----------------------------
// Prompt + parsing
// -----------------------------

const SYSTEM_PREAMBLE = `
You are a turn-based scenario planner. Produce EXACTLY ONE action as strict JSON.
Never include extra prose, code fences, or commentary.
If it is not your turn to message the remote agent, choose a different action.
`;

type ParsedDecision = { reasoning: string; tool: string; args: any };
function parseAction(text: string): ParsedDecision {
  const coerce = (s: string) => {
    let raw = s.trim();
    const m = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
    if (m?.[1]) raw = m[1].trim();
    const i = raw.indexOf('{'); const j = raw.lastIndexOf('}');
    const body = i >= 0 && j > i ? raw.slice(i, j + 1) : raw;
    try {
      const obj = JSON.parse(body);
      // Accept { action: { tool, args }, reasoning }
      if (obj && typeof obj === 'object') {
        const action = obj.action || obj.toolCall || {};
        const tool = String(action.tool || '').trim() || 'sleep';
        const args = action.args || {};
        const reasoning = String(obj.reasoning || obj.thought || '').trim();
        return { reasoning, tool, args };
      }
    } catch {}
    return { reasoning: 'parse-error', tool: 'sleep', args: {} };
  };
  return coerce(text || '');
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
  // Find the latest agent_question and see if a matching agent_answer exists later.
  let lastQid: string | null = null;
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i];
    if (f.type === 'agent_question') { lastQid = f.qid; break; }
  }
  if (!lastQid) return null;
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i];
    if (f.type === 'agent_answer' && f.qid === lastQid) return null;
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
      // Me → other
      lines.push(`<message from="${me}" to="${other}">`);
      if (f.text) lines.push(escapeXml(f.text));
      for (const a of f.attachments || []) lines.push(`<attachment name="${a.name}" mimeType="${a.mimeType}" />`);
      lines.push(`</message>`);
    } else if (f.type === 'remote_received') {
      // Other → me
      lines.push(`<message from="${other}" to="${me}">`);
      if (f.text) lines.push(escapeXml(f.text));
      for (const a of f.attachments || []) lines.push(`<attachment name="${a.name}" mimeType="${a.mimeType}" />`);
      lines.push(`</message>`);
    } else if (f.type === 'tool_call') {
      lines.push(`<tool_call>${escapeXml(JSON.stringify({ action: { tool: f.name, args: f.args } }))}</tool_call>`);
    } else if (f.type === 'tool_result') {
      lines.push(`<tool_result>${escapeXml(JSON.stringify(f.ok ? f.result ?? {} : { ok: false, error: f.error }))}</tool_result>`);
    } else if (f.type === 'agent_question') {
      lines.push(`<message from="${me}" to="user"><private_question>${escapeXml(f.prompt)}</private_question></message>`);
    } else if (f.type === 'agent_answer') {
      lines.push(`<message from="user" to="${me}"><private_answer>${escapeXml(f.text)}</private_answer></message>`);
    }
  }
  return lines.join('\n');
}

function buildAvailableFilesXml(files: AttachmentMeta[]): string {
  if (!files.length) return '<!-- none -->';
  const rows = files.map(a => `<file name="${escapeXml(a.name)}" mimeType="${escapeXml(a.mimeType || 'application/octet-stream')}" source="${escapeXml(a.origin || 'unknown')}" />`);
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
  toolsCatalog: string
): string {
  const me = scenario.agents.find(a => a.agentId === myId);
  const other = scenario.agents.find(a => a.agentId === otherId);
  const header = [
    `You are an agent representing ${me?.principal?.name ?? 'our principal'}.`,
    `Your counterpart is ${other?.principal?.name ?? 'the other agent'}.`,
  ].join('\n');
  return [
    header,
    '\n<HISTORY>',
    xmlHistory || '<!-- empty -->',
    '</HISTORY>',
    '\n<FILES>',
    availableFilesXml,
    '</FILES>',
    '\n',
    toolsCatalog
  ].join('\n');
}

// -----------------------------
// Tools catalog presented to LLM
// -----------------------------

function buildToolsCatalog(scenario: ScenarioConfiguration, opts: { allowSendToRemote: boolean }) {
  const lines: string[] = [];
  lines.push('<TOOLS>');
  lines.push('Respond with exactly ONE JSON object: { reasoning: string, action: { tool: string, args: object } }');
  lines.push('');

  if (opts.allowSendToRemote) {
    lines.push('// Send a message draft to the remote agent (composer will open; sending occurs only when it is your turn).');
    lines.push('interface SendMessageToRemoteAgentArgs { text?: string; attachments?: Array<{ name: string }>; finality?: "none"|"turn"|"conversation"; }');
    lines.push('Tool: sendMessageToRemoteAgent: SendMessageToRemoteAgentArgs');
    lines.push('');
  }

  lines.push('// Ask your user a private question (required blocks planning until answered).');
  lines.push('interface AskUserArgs { prompt: string; required?: boolean; placeholder?: string }');
  lines.push('Tool: askUser: AskUserArgs');
  lines.push('');

  lines.push('// Read bytes of a known attachment by name (private inspection).');
  lines.push('interface ReadAttachmentArgs { name: string }');
  lines.push('Tool: readAttachment: ReadAttachmentArgs');
  lines.push('');

  lines.push('// No action this pass; wait for the next event.');
  lines.push('type SleepArgs = {}');
  lines.push('Tool: sleep: SleepArgs');
  lines.push('');

  // Scenario tools
  const me = scenario?.agents?.[0];
  const mine = scenario?.agents || [];
  const withTools = mine.flatMap(a => a.agentId === (me?.agentId || a.agentId) ? [a] : []);
  const tools = withTools[0]?.tools || [];
  if (tools.length) {
    lines.push('Scenario-Specific Tools:');
    for (const t of tools) {
      lines.push(`// ${t.description}`);
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
  knowledgeBase: Record<string, unknown> | undefined;
  llm: PlanContext['llm'];
  model?: string;
}): Promise<OracleExec> {
  const kb = opts.knowledgeBase || {};
  const sys: LlmMessage = {
    role: 'system',
    content: [
      'You are the Oracle for scenario tools.',
      'Use the provided knowledgeBase to produce outputs.',
      'Return JSON ONLY with the shape: { output: <any>, documents?: Array<{ name, contentType, content }> }',
      'Do not include code fences or commentary.'
    ].join('\n')
  };

  const user: LlmMessage = {
    role: 'user',
    content: [
      `<TOOL_NAME>${opts.tool.toolName}</TOOL_NAME>`,
      `<DESCRIPTION>${opts.tool.description}</DESCRIPTION>`,
      `<SYNTHESIS_GUIDANCE>${opts.tool.synthesisGuidance}</SYNTHESIS_GUIDANCE>`,
      `<INPUT>${JSON.stringify(opts.args || {}, null, 2)}</INPUT>`,
      `<KNOWLEDGE_BASE>${JSON.stringify(kb, null, 2)}</KNOWLEDGE_BASE>`
    ].join('\n')
  };

  try {
    const { text } = await opts.llm.chat({ model: opts.model, messages: [sys, user], temperature: 0.0 });
    const body = parseJsonObject(text);
    const output = body?.output ?? body ?? {};
    const docs = Array.isArray(body?.documents) ? body.documents : [];
    const attachments = docs
      .map((d: any) => {
        const name = String(d?.name || '').trim();
        const contentType = String(d?.contentType || 'text/markdown');
        const content = typeof d?.content === 'string' ? d.content : JSON.stringify(d?.content ?? {}, null, 2);
        if (!name) return null;
        return {
          name,
          mimeType: contentType,
          bytesBase64: toBase64(content)
        };
      })
      .filter(Boolean) as Array<{ name: string; mimeType: string; bytesBase64: string }>;
    return { ok: true, result: output, attachments };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'oracle failed'), attachments: [] };
  }
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

function safeDecodeUtf8(b64: string, max = 2000): string {
  try {
    // Browser path
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof atob === 'function') {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dec = new TextDecoder('utf-8').decode(bytes);
      return dec.slice(0, max);
    }
  } catch {}
  // Node/Bun
  // eslint-disable-next-line no-undef
  const dec = Buffer.from(b64, 'base64').toString('utf-8');
  return dec.slice(0, max);
}

function findScenarioTool(scenario: ScenarioConfiguration, myId: string, toolName: string): ScenarioTool | undefined {
  const me = scenario.agents.find(a => a.agentId === myId) || scenario.agents[0];
  return (me?.tools || []).find(t => t.toolName === toolName);
}

function sleepFact(why: string, includeWhy: boolean, extraWhy?: string): ProposedFact {
  return (includeWhy
    ? { type: 'sleep', reason: why, why: extraWhy ? `${why} — ${extraWhy}` : why }
    : { type: 'sleep', reason: why }) as unknown as ProposedFact;
}
