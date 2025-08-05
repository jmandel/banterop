// src/frontend/scenario-builder/utils/prompt-builder.ts
import type { ScenarioConfiguration } from '$lib/types.js';

export interface BuildScenarioBuilderPromptParams {
  scenario: ScenarioConfiguration;
  history?: Array<{ 
    role: 'user' | 'assistant'; 
    content: string;
    toolCalls?: {
      patches?: Array<{ op: string; path: string; value?: any; from?: string }>;
      replaceEntireScenario?: any;
    };
  }>;
  userMessage: string;
  schemaText: string;      // Full or curated text of scenario-configuration.types.ts
  examplesText?: string;   // Optional: additional long examples (e.g., full infliximab example)
  modelCapabilitiesNote?: string; // Optional UX note about available models, constraints
}

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

export function buildScenarioBuilderPrompt(params: BuildScenarioBuilderPromptParams): string {
  const {
    scenario,
    history = [],
    userMessage,
    schemaText,
    examplesText,
    modelCapabilitiesNote
  } = params;

  const systemPromptSection = `
<SYSTEM_PROMPT>
You are the Scenario Builder LLM for language-first interoperability (schema v2.4).
Your job is to help the user iteratively modify a ScenarioConfiguration through minimal, safe, and reversible edits.

Key principles:
- The superstructure is fixed: metadata, scenario, agents[]
- Agents have: agentId, principal, situation, systemPrompt, goals, tools, knowledgeBase
- Agents can optionally have messageToUseWhenInitiatingConversation
- Tools represent information-retrieval or computation capabilities. Terminal tools (endsConversation) represent decisions that end a simulated conversation.
- Never invent unknown fields. Keep schema integrity.
- Prefer JSON Patch (RFC 6902) for small edits. Use replaceEntireScenario only when changes are too large for patches.
- Always explain what changed and why in "message".
- If user's intent is unclear, ask a clarifying question in "message" and do NOT return patches or replaceEntireScenario.
- Never change metadata.id unless the user explicitly asks.

You do not stream. Return a single JSON code block only.
</SYSTEM_PROMPT>`.trim();

  const schemaGuideSection = `
<SCENARIO_SCHEMA_GUIDE>
Here is the canonical schema guidance, commentary, and examples (from scenario-configuration.types.ts).
This is your source-of-truth for the valid ScenarioConfiguration structure and authoring philosophy:

${SEP}
${schemaText}
${SEP}

${examplesText ? `\n<DETAILED_EXAMPLES>\n${examplesText}\n</DETAILED_EXAMPLES>\n` : ''}
</SCENARIO_SCHEMA_GUIDE>`.trim();

  const availableActionsSection = `
<AVAILABLE_ACTIONS>
Your output MUST be a single JSON code block with exactly these keys:

Required:
- "message": string

Optional (choose at most one):
- "patches": an array of RFC 6902 JSON Patch operations
- "replaceEntireScenario": a complete ScenarioConfiguration object

Constraints:
- Only one JSON code block; no text outside it.
- If you need clarification, return only "message" (no patches, no replaceEntireScenario).
- Prefer patches. Use replaceEntireScenario sparingly.
- Never modify metadata.id unless explicitly requested.
- Keep changes minimal and reversible.
</AVAILABLE_ACTIONS>`.trim();

  const currentScenarioSection = `
<CURRENT_SCENARIO>
\`\`\`json
${JSON.stringify(scenario, null, 2)}
\`\`\`
</CURRENT_SCENARIO>`.trim();

  console.log('=== PROMPT BUILDER: Building conversation history ===');
  console.log('History length:', history.length);
  console.log('History entries:', history);
  
  const conversationHistorySection = `
<CONVERSATION_HISTORY>
${history.length === 0 ? '(This is the start of our builder conversation)' :
  history.map((m, i) => {
    let entry = `${i + 1}. ${m.role.toUpperCase()}: ${m.content}`;
    
    // Include tool calls for assistant messages
    if (m.role === 'assistant' && m.toolCalls) {
      if (m.toolCalls.patches && m.toolCalls.patches.length > 0) {
        entry += `\n   [Applied ${m.toolCalls.patches.length} patch${m.toolCalls.patches.length > 1 ? 'es' : ''}]`;
      } else if (m.toolCalls.replaceEntireScenario) {
        entry += '\n   [Replaced entire scenario]';
      }
    }
    
    return entry;
  }).join('\n')}
^^ Reply to this last user turn
</CONVERSATION_HISTORY>`.trim();
  
  console.log('=== CONVERSATION HISTORY SECTION ===');
  console.log(conversationHistorySection);

  const responseInstructionsSection = `
<RESPONSE_INSTRUCTIONS>
Your entire response MUST be a single JSON code block:

Example (patches):
\`\`\`json
{
  "message": "I replaced the title with a clearer one.",
  "patches": [
    { "op": "replace", "path": "/metadata/title", "value": "Clearer Scenario Title" }
  ]
}
\`\`\`

Example (replace entire scenario - rare):
\`\`\`json
{
  "message": "Rewriting the scenario as requested.",
  "replaceEntireScenario": {
    "metadata": { "id": "scen_original_id", "title": "New Title", "description": "..." },
    "scenario": { "background": "...", "challenges": ["..."] },
    "agents": [ /* full AgentConfiguration[] */ ]
  }
}
\`\`\`

Example (clarification):
\`\`\`json
{
  "message": "Do you want agent 'supplier' to initiate and include a terminal approval tool?",
  "patches": []
}
\`\`\`

Do NOT include any text outside the code block. Do NOT return both "patches" and "replaceEntireScenario".
Never modify metadata.id unless explicitly asked.
</RESPONSE_INSTRUCTIONS>`.trim();

  const modelNote = modelCapabilitiesNote
    ? `\n<MODEL_CAPABILITIES>\n${modelCapabilitiesNote}\n</MODEL_CAPABILITIES>\n`
    : '';

  const finalNudge = `
Produce your response now, following the exact schema, as a single JSON code block with "message" and optionally "patches" or "replaceEntireScenario".
`.trim();

  const sections = [
    systemPromptSection,
    SEP,
    schemaGuideSection,
    SEP,
    availableActionsSection,
    SEP,
    currentScenarioSection,
    SEP,
    responseInstructionsSection,
    SEP,
    conversationHistorySection,
    SEP,
    modelNote,
    SEP,
    finalNudge
  ];

  return sections.join('\n\n');
}