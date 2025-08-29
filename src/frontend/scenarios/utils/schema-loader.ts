// Load the full schema/types file as raw text at build time (Bun)
// This ensures the LLM prompt always has the exact, current schema guidance.
// If you add example material to the types file in the future, you can split it here.
// Bun supports: import text from 'path' with { type: 'text' }
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - Bun runtime supports the following import assertion
import schemaFileContent from '../../../types/scenario-configuration.types.ts' with { type: 'text' };

// Optionally split curated schema from embedded examples if a marker exists
const lines = (schemaFileContent as string).split('\n');
const exampleStartIndex = lines.findIndex((line) => line.includes('const infliximabScenarioFinal'));

const curatedSchema = exampleStartIndex > 0
  ? lines.slice(0, exampleStartIndex).join('\n').trim()
  : (schemaFileContent as string);

const exampleText = exampleStartIndex > 0
  ? lines.slice(exampleStartIndex).join('\n').trim()
  : '';

export function getCuratedSchemaText(): string {
  return curatedSchema;
}

export function getExampleScenarioText(): string {
  return exampleText;
}
