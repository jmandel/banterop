export function buildScenarioBuilderPrompt(opts: {
  scenario: any;
  history: Array<{ role: 'user' | 'assistant'; content: string; toolCalls?: any }>;
  userMessage: string;
  schemaText: string;
  examplesText: string;
  modelCapabilitiesNote?: string;
}): string {
  const { scenario, history, userMessage, schemaText, examplesText, modelCapabilitiesNote = '' } = opts;
  const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const sections: string[] = [];

  sections.push(
    'You are the Scenario Builder LLM for language-first interoperability.',
    'Your job is to help the user iteratively modify a ScenarioConfiguration through minimal, safe, and reversible edits.'
  );

  if (modelCapabilitiesNote) sections.push('\n<MODEL_CAPABILITIES>\n' + modelCapabilitiesNote + '\n</MODEL_CAPABILITIES>');

  sections.push(
    '\n<SCENARIO_SCHEMA_GUIDE>\nThis is your source-of-truth for the valid ScenarioConfiguration structure and authoring philosophy:\n' +
      SEP + '\n' + schemaText + '\n' + SEP +
      (examplesText ? ('\n<DETAILED_EXAMPLES>\n' + examplesText + '\n</DETAILED_EXAMPLES>') : '') +
    '\n</SCENARIO_SCHEMA_GUIDE>'
  );

  sections.push(
    '\n<CURRENT_SCENARIO>\n```json\n' + JSON.stringify(scenario, null, 2) + '\n```\n</CURRENT_SCENARIO>'
  );

  sections.push(
    '\n<CONVERSATION_HISTORY>\n' +
      (history.length === 0 ? '(start)' : history.map((m, i) => `${i + 1}. ${m.role.toUpperCase()}: ${m.content}`).join('\n')) +
    '\n^^ Reply to the last user turn.\n</CONVERSATION_HISTORY>'
  );

  sections.push(
    '\n<AVAILABLE_ACTIONS>\n' +
    'Your entire response MUST be a single JSON code block with keys:\n' +
    '- "message": string (required)\n' +
    '- EITHER "patches": RFC6902 operations[] OR "replaceEntireScenario": ScenarioConfiguration\n' +
    'Do NOT include any text outside the code block.\n' +
    'Prefer patches; use replaceEntireScenario only when changes are too large.\n' +
    'Never change metadata.id unless explicitly requested.\n' +
    '</AVAILABLE_ACTIONS>'
  );

  sections.push(
    '\n<RESPONSE_EXAMPLES>\n' +
    '```json\n{\n  "message": "I updated the title.",\n  "patches": [{ "op": "replace", "path": "/metadata/title", "value": "New Title" }]\n}\n```\n' +
    '```json\n{\n  "message": "Rewriting the scenario as requested.",\n  "replaceEntireScenario": { "metadata": {...}, "scenario": {...}, "agents": [...] }\n}\n```\n' +
    '</RESPONSE_EXAMPLES>'
  );

  sections.push('\n<USER_REQUEST>\n' + userMessage + '\n</USER_REQUEST>');

  sections.push('\nProduce your response now as a single JSON code block.');

  return sections.join('\n');
}
