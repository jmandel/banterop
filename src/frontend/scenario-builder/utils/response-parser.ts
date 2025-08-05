// src/frontend/scenario-builder/utils/response-parser.ts

export interface BuilderLLMResult {
  message: string;
  patches?: Array<{ op: string; path: string; value?: any; from?: string }>;
  replaceEntireScenario?: any; // Validate minimally in the caller before applying
}

export function parseBuilderLLMResponse(content: string): BuilderLLMResult {
  // 1) Try extracting the last ```json code block
  const jsonBlockMatch = findLastJsonCodeBlock(content);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch);
      validateBuilderResultShape(parsed);
      return parsed;
    } catch (e) {
      // Fall through to fallback heuristic
    }
  }

  // 2) Try generic ``` ... ``` block that looks like JSON
  const genericBlock = findLastGenericJsonBlock(content);
  if (genericBlock) {
    try {
      const parsed = JSON.parse(genericBlock);
      validateBuilderResultShape(parsed);
      return parsed;
    } catch (e) { /* continue */ }
  }

  // 3) Fallback: try first bare JSON object
  const bare = findFirstBareJson(content);
  if (bare) {
    try {
      const parsed = JSON.parse(bare);
      validateBuilderResultShape(parsed);
      return parsed;
    } catch (e) { /* continue */ }
  }

  throw new Error('LLM response did not contain a valid JSON result block.');
}

function validateBuilderResultShape(obj: any) {
  if (!obj || typeof obj !== 'object') {
    throw new Error('Parsed JSON is not an object.');
  }
  if (typeof obj.message !== 'string' || obj.message.trim().length === 0) {
    throw new Error('Missing required "message" string.');
  }
  const hasPatches = Array.isArray(obj.patches);
  const hasReplacement = typeof obj.replaceEntireScenario === 'object' && obj.replaceEntireScenario !== null;

  // At most one of patches or replaceEntireScenario
  if (hasPatches && hasReplacement) {
    throw new Error('Result must not include both "patches" and "replaceEntireScenario".');
  }

  // Optional shape checks for patches
  if (hasPatches) {
    for (const p of obj.patches) {
      if (!p || typeof p.op !== 'string' || typeof p.path !== 'string') {
        throw new Error('Invalid patch operation: each patch must have "op" and "path".');
      }
    }
  }
}

function findLastJsonCodeBlock(text: string): string | null {
  const regex = /```json\s*([\s\S]*?)\s*```/gi;
  let last: string | null = null;
  let m;
  while ((m = regex.exec(text)) !== null) {
    last = m[1]!.trim();
  }
  return last;
}

function findLastGenericJsonBlock(text: string): string | null {
  const regex = /```\s*([\s\S]*?)\s*```/gi;
  let last: string | null = null;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const candidate = m[1]!.trim();
    if (candidate.startsWith('{') && candidate.includes('"message"')) {
      last = candidate;
    }
  }
  return last;
}

function findFirstBareJson(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}