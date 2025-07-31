// Agent Factory - Creates agents with proper client injection

import type { ConversationDatabase } from '$backend/db/database.js';
import type { OrchestratorClient } from '$client/index.js';
import {
  AgentConfig, AgentInterface,
  ScenarioDrivenAgentConfig,
  SequentialScriptConfig,
} from '$lib/types.js';
import type { LLMProvider } from 'src/types/llm.types.js';
import { ScenarioDrivenAgent } from './scenario-driven.agent.js';
import { SequentialScriptAgent } from './sequential-script.agent.js';
import { ToolSynthesisService } from './services/tool-synthesis.service.js';


// Main Agent Factory with Dependency Injection
export function createAgent(
  config: AgentConfig, 
  client: OrchestratorClient,
  // Injected system-level dependencies:
  db: ConversationDatabase,
  llmProvider: LLMProvider,
  toolSynthesisService: ToolSynthesisService 
): AgentInterface {
  switch (config.strategyType) {
    case 'scenario_driven':
      return new ScenarioDrivenAgent(config as ScenarioDrivenAgentConfig, client, db, llmProvider, toolSynthesisService);
    case 'sequential_script':
      return new SequentialScriptAgent(config as SequentialScriptConfig, client);
    default:
      throw new Error(`Unknown or unsupported strategy type for client-based agent: ${config.strategyType}`);
  }
}
