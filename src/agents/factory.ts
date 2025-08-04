// Agent Factory - Creates agents with proper client injection

import type { ConversationDatabase } from '$backend/db/database.js';
import type { OrchestratorClient } from '$client/index.js';
import {
  AgentConfig, AgentInterface,
  ScenarioDrivenAgentConfig,
  SequentialScriptConfig,
  StaticReplayConfig,
  ScenarioConfiguration,
} from '$lib/types.js';
import type { LLMProvider } from 'src/types/llm.types.js';
import { ScenarioDrivenAgent } from './scenario-driven.agent.js';
import { SequentialScriptAgent } from './sequential-script.agent.js';
import { StaticReplayAgent } from './static-replay.agent.js';
import { ToolSynthesisService } from './services/tool-synthesis.service.js';


// Main Agent Factory with Dependency Injection
export function createAgent(
  config: AgentConfig, 
  client: OrchestratorClient,
  // Group all dependencies into a single object
  dependencies: {
    db: ConversationDatabase;
    llmProvider: LLMProvider;
    toolSynthesisService: ToolSynthesisService;
    scenario?: ScenarioConfiguration; // Optional, as not all agents need it
  }
): AgentInterface {
  switch (config.strategyType) {
    case 'scenario_driven':
      if (!dependencies.scenario) {
        throw new Error('ScenarioDrivenAgent requires a scenario configuration to be provided via dependencies.');
      }
      return new ScenarioDrivenAgent(
        config as ScenarioDrivenAgentConfig, 
        client, 
        dependencies.scenario, // Pass the scenario object directly
        dependencies.llmProvider, 
        dependencies.toolSynthesisService
      );
    case 'sequential_script':
      return new SequentialScriptAgent(config as SequentialScriptConfig, client);
    case 'static_replay':
      return new StaticReplayAgent(config as StaticReplayConfig, client);
    default:
      throw new Error(`Unknown or unsupported strategy type for client-based agent: ${config.strategyType}`);
  }
}
