export interface BuilderLLMResult {
  message: string;
  patches?: Array<{ op: string; path: string; value?: unknown; from?: string }>;
  replaceEntireScenario?: unknown;
}

export function parseBuilderLLMResponse(content: string): BuilderLLMResult {
  const jsonBlockMatch = findLastJsonCodeBlock(content);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch);
      return coerceOrValidate(parsed);
    } catch {}
  }

  const genericBlock = findLastGenericJsonBlock(content);
  if (genericBlock) {
    try {
      const parsed = JSON.parse(genericBlock);
      return coerceOrValidate(parsed);
    } catch {}
  }

  const bare = findFirstBareJson(content);
  if (bare) {
    try {
      const parsed = JSON.parse(bare);
      return coerceOrValidate(parsed);
    } catch {}
  }

  throw new Error('LLM response did not contain a valid JSON result block.');
}

function coerceOrValidate(obj: any): BuilderLLMResult {
  if (!obj || typeof obj !== 'object') {
    throw new Error('Parsed JSON is not an object.');
  }
  const hasPatches = Array.isArray(obj.patches);
  const hasReplacement = typeof obj.replaceEntireScenario === 'object' && obj.replaceEntireScenario !== null;
  if (typeof obj.message !== 'string' || obj.message.trim().length === 0) {
    if (hasPatches) {
      const n = Array.isArray(obj.patches) ? obj.patches.length : 0;
      obj.message = `Applied ${n} patch${n === 1 ? '' : 'es'}.`;
    } else if (hasReplacement) {
      obj.message = 'Replaced entire scenario.';
    } else {
      throw new Error('Missing required "message" string.');
    }
  }
  if (hasPatches && hasReplacement) {
    throw new Error('Result must not include both "patches" and "replaceEntireScenario".');
  }
  if (hasPatches) {
    for (const p of obj.patches) {
      if (!p || typeof p.op !== 'string' || typeof p.path !== 'string') {
        throw new Error('Invalid patch operation: each patch must have "op" and "path".');
      }
    }
  }
  return obj as BuilderLLMResult;
}

function findLastJsonCodeBlock(text: string): string | null {
  const regex = /```json\s*([\s\S]*?)\s*```/gi;
  let last: string | null = null;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = regex.exec(text)) !== null) last = m[1]!.trim();
  return last;
}

function findLastGenericJsonBlock(text: string): string | null {
  const regex = /```\s*([\s\S]*?)\s*```/gi;
  let last: string | null = null;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = regex.exec(text)) !== null) {
    const candidate = m[1]!.trim();
    if (candidate.startsWith('{') && candidate.includes('"message"')) last = candidate;
  }
  return last;
}

function findFirstBareJson(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}
