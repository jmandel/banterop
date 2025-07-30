// Agent Factory - Creates agents with proper client injection

import { 
  AgentConfig, AgentInterface, RuleBasedConfig, 
  ExternalProxyConfig,
  ScenarioDrivenAgentConfig, StaticReplayConfig, SequentialScriptConfig
} from '$lib/types.js';
import type { OrchestratorClient } from '$client/index.js';
import type { ConversationDatabase } from '$backend/db/database.js';
import type { LLMProvider } from '$llm/types.js';
import { StaticReplayAgent } from './static-replay.agent.js';
import { ScenarioDrivenAgent } from './scenario-driven.agent.js';
import { SequentialScriptAgent } from './sequential-script.agent.js';
import { ToolSynthesisService } from './services/tool-synthesis.service.js';
import { RuleBasedAgent } from './impl/rule-based.agent.js';
import { ExternalProxyAgent } from './impl/external-proxy.agent.js';


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
    case 'static_replay':
      return new StaticReplayAgent(config as StaticReplayConfig, client);
    case 'rule_based':
      return new RuleBasedAgent(config as RuleBasedConfig, client);
    case 'external_proxy':
      return new ExternalProxyAgent(config as ExternalProxyConfig, client);
    case 'scenario_driven':
      return new ScenarioDrivenAgent(config as ScenarioDrivenAgentConfig, client, db, llmProvider, toolSynthesisService);
    case 'sequential_script':
      return new SequentialScriptAgent(config as SequentialScriptConfig, client);
    default:
      throw new Error(`Unknown or unsupported strategy type for client-based agent: ${config.strategyType}`);
  }
}
