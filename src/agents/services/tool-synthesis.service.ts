// src/agents/services/tool-synthesis.service.ts
//
// ToolSynthesisService – "Oracle" / World Simulator for Scenario-driven runs
//
// Purpose
// - Given an agent persona, a tool definition (with synthesisGuidance), the scenario context,
//   and a conversation history excerpt, produce a realistic tool execution result.
// - The Oracle is omniscient for synthesis: it can "see" the whole scenario (including
//   each agent's private knowledgeBase if present), but must only reveal what is plausible
//   for the specific tool being called.
//
// Changes vs prior draft
// - Embeds agent-specific knowledge more liberally, following v2 pattern:
//   - Includes the calling agent's knowledgeBase in full (up to a generous cap)
//   - Includes summarized knowledge for other agents (also capped)
//   - Still reminds the Oracle to reveal only what the tool plausibly knows
//
// Usage
//   const oracle = new ToolSynthesisService(provider, { maxKbCharsPerAgent: 20000 });
//   const result = await oracle.execute({
//     tool: { toolName, description, synthesisGuidance, inputSchema, endsConversation, conversationEndStatus },
//     args: {...},
//     agent: { agentId, principal, situation, systemPrompt, goals },
//     scenario, // ScenarioConfiguration (static scenario data)
//     conversationHistory: historyAsString,
//   });
//
// Output contract
// - Single JSON code block: { "reasoning": string, "output": any }
// - Robust parser included to handle imperfect model formatting
//

import type { LLMProvider, LLMMessage } from '$src/types/llm.types';
import type {
  ScenarioConfiguration,
  ScenarioConfigAgentDetails,
} from '$src/types/scenario-configuration.types';

// Input definitions for Oracle execution

export interface OraclePrincipal {
  type: 'individual' | 'organization';
  name: string;
  description: string;
}

export interface OracleAgentPersona {
  agentId: string;
  principal?: OraclePrincipal;
  situation?: string;
  systemPrompt?: string;
  goals?: string[];
}

export interface OracleToolDef {
  toolName: string;
  description: string;
  inputSchema?: { type: 'object'; properties?: Record<string, any>; required?: string[] };
  synthesisGuidance: string;
  endsConversation?: boolean;
  conversationEndStatus?: 'success' | 'failure' | 'neutral';
}

export interface ToolExecutionInput {
  tool: OracleToolDef;
  args: Record<string, unknown>;
  agent: OracleAgentPersona;
  scenario: ScenarioConfiguration;
  conversationHistory: string; // include recent window for realism
}

export interface ToolExecutionOutput {
  output: unknown;
  reasoning: string;
}

export interface ToolSynthesisOptions {
  // Budget settings (characters). These are generous by default to mirror v2 "liberal" embedding.
  maxHistoryChars?: number;          // default 20k
  maxKbCharsPerAgent?: number;       // default 30k per agent
  maxOtherAgentsKbTotalChars?: number; // default 30k total for all others
  temperature?: number;              // default 0.7
}

export class ToolSynthesisService {
  private maxHistoryChars: number;
  private maxKbCharsPerAgent: number;
  private maxOtherKbTotal: number;
  private temperature: number;

  constructor(private llm: LLMProvider, opts?: ToolSynthesisOptions) {
    this.maxHistoryChars = Math.max(2000, opts?.maxHistoryChars ?? 20_000);
    this.maxKbCharsPerAgent = Math.max(5000, opts?.maxKbCharsPerAgent ?? 30_000);
    this.maxOtherKbTotal = Math.max(5000, opts?.maxOtherAgentsKbTotalChars ?? 30_000);
    this.temperature = opts?.temperature ?? 0.7;
  }

  async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    /**
     * WARNING (Connectathon mode):
     * This service does NOT validate the shape of tool `output` against
     * the tool's `inputSchema` or any other constraints.
     * It is assumed that upstream orchestration & LLM prompts
     * produce correct data.
     * Production deployments should integrate strict schema validation here.
     */
    if (!input?.tool?.toolName || !input.tool.synthesisGuidance) {
      throw new Error('ToolSynthesisService: tool.toolName and tool.synthesisGuidance are required');
    }
    if (!input?.scenario?.metadata?.id) {
      throw new Error('ToolSynthesisService: scenario metadata is required');
    }

    const prompt = this.buildOraclePrompt(input);
    const messages: LLMMessage[] = [{ role: 'user', content: prompt }];

    const attempt = async (msgs: LLMMessage[], temp: number) => {
      const resp = await this.llm.complete({ messages: msgs, temperature: temp });
      return this.parseOracleResponse(resp.content || '');
    };

    try {
      return await attempt(messages, this.temperature);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('Oracle response was not valid JSON with required { reasoning, output } shape.')) {
        // One-time retry with an explicit formatting reminder and slightly lower temperature
        const retryMessages: LLMMessage[] = [
          { role: 'user', content: prompt },
          { role: 'system', content: 'Return exactly one JSON code block with keys "reasoning" (string) and "output" (JSON). No extra text.' },
        ];
        try {
          return await attempt(retryMessages, Math.max(0, this.temperature - 0.3));
        } catch {
          // Fall through to throw the original error for clearer diagnostics upstream
        }
      }
      throw e;
    }
  }

  // Prompt assembly (liberal knowledge embedding)
  private buildOraclePrompt(input: ToolExecutionInput): string {
    const { tool, args, agent, scenario } = input;
    const history = this.truncate(input.conversationHistory, this.maxHistoryChars, '... [history truncated]');
    const scenarioHeader = this.formatScenarioHeader(scenario);
    const agentProfile = this.formatAgentProfile(agent);

    // Calling agent definition (from scenario.agents, v3 in repo)
    const callingAgentDef = this.getAgentDef(scenario, agent.agentId);

    // Extract knowledge for calling agent (liberal: full up to cap)
    const myKb = this.extractKnowledgeFromAgentDef(callingAgentDef);
    const myKbStr = this.prettyOrString(myKb);
    const myKbTrunc = this.truncate(myKbStr, this.maxKbCharsPerAgent, '... [calling agent knowledge truncated]');

    // Other agents’ knowledge (summarized, but still sizable)
    const others = (scenario.agents || []).filter((a) => a.agentId !== agent.agentId);
    const otherKbSections: string[] = [];
    let remaining = this.maxOtherKbTotal;

    for (const other of others) {
      const otherKb = this.extractKnowledgeFromAgentDef(other);
      if (otherKb == null) continue;
      const header = `- agentId: ${other.agentId} (${other.principal.name})`;
      const kbStr = this.prettyOrString(otherKb);
      const budget = Math.max(1000, Math.min(remaining, this.maxKbCharsPerAgent));
      const kbTrunc = this.truncate(kbStr, budget, '... [other agent knowledge truncated]');
      otherKbSections.push(`${header}\n${kbTrunc}`);
      remaining -= kbTrunc.length + header.length + 1;
      if (remaining <= 0) break;
    }

    const otherKbBlock = otherKbSections.length
      ? ['OTHER AGENTS KNOWLEDGE (Omniscient view, reveal only what the tool plausibly knows):', ...otherKbSections].join('\n')
      : 'OTHER AGENTS KNOWLEDGE: (none present or budget exhausted)';

    // Scenario knowledge (shared)
    const scenarioKnowledge = this.formatScenarioKnowledge(scenario);
    const metadataBlock = this.prettyOrString({
      id: scenario.metadata?.id,
      title: scenario.metadata?.title,
      description: scenario.metadata?.description,
      background: (scenario.metadata as any)?.background,
      challenges: (scenario.metadata as any)?.challenges,
      tags: scenario.metadata?.tags,
    });

    // Director’s notes and terminal tool guidance
    const directorsNote = tool.synthesisGuidance;
    const terminalNote = tool.endsConversation
      ? `This tool is TERMINAL (endsConversation=true). Your output should help conclude the conversation. outcome="${tool.conversationEndStatus ?? 'neutral'}".`
      : `This tool is NOT terminal. Produce output to advance the conversation.`;

    // Document guidance
    const documentGuidance = `
DOCUMENT OUTPUT FORMATS:

1) Document Output (Preferred when the tool's output is a report/document):
{
  "docId": "unique-document-id",
  "contentType": "text/markdown",
  "content": "The document content...",
  "name": "Optional display name",
  "summary": "Optional short summary"
}

2) JSON Object Output (when the tool's output is naturally a JSON object):
{
  // Idiomatic fields for the tool's output
  // If you need to embed a document, use the Document Output format (at any nested level)
}`;

// 3) Document Reference (when pointing to a resolvable reference only):
// {
//   "refToDocId": "unique-logical-identifier",
//   "name": "Document name",
//   "type": "Document type",
//   "contentType": "text/markdown",
//   "summary": "Brief summary",
//   "details": { ...context for future resolution... }
// }

// `;

    // Interop constraints
    const interopConstraints = `
CONVERSATIONAL INTEROPERABILITY CONSTRAINTS:
- The conversation thread is the sole channel of exchange.
- Do NOT suggest portals, emails, fax, or separate submission flows.
- Encourage sharing documents via conversation attachments (by docId) when appropriate.
- Reveal only what the specific tool would plausibly know, even though you are omniscient.
`;

    // Output contract
    const outputContract = `
OUTPUT CONTRACT:
- Return exactly one JSON code block.
- The JSON MUST have keys: "reasoning" (string) and "output" (any JSON).
- No extra text outside the code block.

EXAMPLE:
\`\`\`json
{
  "reasoning": "How you derived the output from context & tool intent.",
  "output": {
    "docId": "doc_policy_123",
    "contentType": "text/markdown",
    "content": "# Policy ...",
    "summary": "Highlights the specific criteria and applicability to this case."
  }
}
\`\`\`
`;

    return [
      'You are an omniscient Oracle / World Simulator for a scenario-driven, multi-agent conversation.',
      'Your role: execute a tool call with realistic, in-character results.',
      '',
      scenarioHeader,
      '',
      agentProfile,
      '',
      'CALLING AGENT KNOWLEDGEBASE (liberal embedding):',
      myKbTrunc || '(none)',
      '',
      otherKbBlock,
      '',
      scenarioKnowledge,
      '',
      'SCENARIO METADATA (JSON):',
      metadataBlock,
      '',
      'TOOL INVOCATION:',
      `- name: ${tool.toolName}`,
      `- description: ${tool.description || '(no description provided)'}`,
      `- inputSchema: ${this.safeJson(tool.inputSchema ?? { type: 'object' })}`,
      `- arguments: ${this.safeJson(args)}`,
      '',
      'DIRECTOR_NOTE_FOR_ORACLE:',
      directorsNote,
      '',
      terminalNote,
      interopConstraints,
      documentGuidance,
      '',
      'CONVERSATION HISTORY (liberal embedding):',
      history || '(none)',
      '',
      outputContract,
      'Now produce your response.',
    ].join('\n');
  }

  private getAgentDef(s: ScenarioConfiguration, agentId: string): ScenarioConfigAgentDetails | undefined {
    return (s.agents || []).find((a) => a.agentId === agentId);
  }

  // Extracts the knowledgeBase from AgentConfiguration
  private extractKnowledgeFromAgentDef(agent?: ScenarioConfigAgentDetails): unknown {
    if (!agent) return null;
    // AgentConfiguration has knowledgeBase directly
    return agent.knowledgeBase || null;
  }

  private formatScenarioHeader(s: ScenarioConfiguration): string {
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

  private formatScenarioKnowledge(s: ScenarioConfiguration): string {
    // The repo's v3 ScenarioConfiguration includes optional knowledge at top-level; embed if present.
    const k = (s as any).knowledge;
    if (!k) return 'SCENARIO KNOWLEDGE: (none)';

    const facts = Array.isArray(k.facts) && k.facts.length
      ? k.facts.map((f: string, i: number) => `  ${i + 1}. ${f}`).join('\n')
      : '  (none)';

    const documents = Array.isArray(k.documents) && k.documents.length
      ? k.documents.map((d: any) => `  - [${d.id}] ${d.title} (${d.type})`).join('\n')
      : '  (none)';

    const refs = Array.isArray(k.references) && k.references.length
      ? k.references.map((r: any) => `  - ${r.title}: ${r.url}`).join('\n')
      : '  (none)';

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

  private formatAgentProfile(a: OracleAgentPersona): string {
    const principal = a.principal
      ? `${a.principal.name} — ${a.principal.description}`
      : '(principal not specified)';
    const goals = a.goals?.length ? a.goals.map((g) => `  - ${g}`).join('\n') : '  (none)';
    return [
      'CALLING AGENT PROFILE:',
      `- agentId: ${a.agentId}`,
      `- principal: ${principal}`,
      `- situation: ${a.situation || '(not specified)'}`,
      `- systemPrompt: ${a.systemPrompt || '(not specified)'}`,
      '- goals:',
      goals,
    ].join('\n');
  }

  // Parsing utilities

  private parseOracleResponse(content: string): ToolExecutionOutput {
    // 1) ```json ... ```
    const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch?.[1]) {
      const obj = this.tryParse(jsonBlockMatch[1]);
      if (obj && this.validateShape(obj)) {
        return { reasoning: obj.reasoning, output: obj.output };
      }
    }
    // 2) ``` ... ```
    const genericBlockMatch = content.match(/```\s*([\s\S]*?)\s*```/);
    if (genericBlockMatch?.[1]) {
      const obj = this.tryParse(genericBlockMatch[1]);
      if (obj && this.validateShape(obj)) {
        return { reasoning: obj.reasoning, output: obj.output };
      }
    }
    // 3) First bare JSON object
    const bareObject = this.extractFirstJsonObject(content);
    if (bareObject) {
      const obj = this.tryParse(bareObject);
      if (obj && this.validateShape(obj)) {
        return { reasoning: obj.reasoning, output: obj.output };
      }
    }
    // 4) Heuristic fallback
    const heuristic = this.heuristicParse(content);
    if (heuristic) return heuristic;

    throw new Error('Oracle response was not valid JSON with required { reasoning, output } shape.');
  }

  private validateShape(obj: any): obj is { reasoning: string; output: unknown } {
    return obj && typeof obj === 'object' && typeof obj.reasoning === 'string' && 'output' in obj;
  }

  private tryParse(jsonLike: string): any | null {
    try {
      return JSON.parse(jsonLike);
    } catch {
      return null;
    }
  }

  private extractFirstJsonObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
      }
      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  private heuristicParse(content: string): ToolExecutionOutput | null {
    const reasoningMatch = content.match(/"reasoning"\s*:\s*"([^"]*)"/);
    const reasoning = reasoningMatch?.[1] ?? 'No explicit reasoning found (heuristic parse).';

    const outputIdx = content.indexOf('"output"');
    if (outputIdx === -1) return null;

    const after = content.slice(outputIdx + '"output"'.length);
    const colon = after.indexOf(':');
    if (colon === -1) return null;

    const valueStr = after.slice(colon + 1).trim();
    let output: unknown = valueStr;

    const firstChar = valueStr[0];
    if (firstChar === '{' || firstChar === '[' || firstChar === '"') {
      const candidate = this.extractFirstJsonObject(valueStr) ?? valueStr;
      const parsed = this.tryParse(candidate);
      if (parsed !== null) output = parsed;
    }
    return { reasoning, output };
  }

  // Helpers

  private prettyOrString(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  private truncate(s: string, max: number, suffix = '...'): string {
    if (!s) return s;
    if (s.length <= max) return s;
    if (max <= suffix.length) return s.slice(0, max);
    return s.slice(0, max - suffix.length) + suffix;
  }

  private safeJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}

/*
TODOs / Future Enhancements:
- Validate tool args against inputSchema (zod) and echo validation errors in reasoning.
- Optional deterministic mode (temperature=0) for replayable tests.
- Pluggable budget policy (word/token-aware truncation rather than char-based).
- Auto-assign docId when missing for doc-like outputs; avoid collisions.
- Redaction hooks for sensitive data in knowledge bases (per environment).
*/
