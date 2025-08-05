// Schema loader utility - loads the scenario configuration types at build time
// This ensures the prompt always has the latest schema documentation

// Import the schema file content directly using Bun's text import
import schemaFileContent from '../../../types/scenario-configuration.types.ts' with { type: 'text' };

// Parse the schema content once at module load time
const lines = schemaFileContent.split('\n');
const exampleStartIndex = lines.findIndex(line => 
  line.includes('const infliximabScenarioFinal')
);

const curatedSchema = exampleStartIndex > 0 
  ? lines.slice(0, exampleStartIndex).join('\n').trim()
  : schemaFileContent;
  
const exampleText = exampleStartIndex > 0
  ? lines.slice(exampleStartIndex).join('\n').trim()
  : '';

export function getSchemaText(): string {
  return schemaFileContent;
}

// Extract just the documentation and type definitions, removing the example
export function getCuratedSchemaText(): string {
  return curatedSchema;
}

// Extract just the example scenario
export function getExampleScenarioText(): string {
  return exampleText;
}