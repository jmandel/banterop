import { Storage } from './orchestrator/storage';
import { OrchestratorService } from './orchestrator/orchestrator';
import { ConfigManager, type Config } from './config';
import { LLMProviderManager } from '$src/llm/provider-manager';
import type { SchedulePolicy } from '$src/types/orchestrator.types';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import { AgentHost } from './agent-host';
import { resumeActiveConversations } from './agent-host-resume';
import kneeMriScenario from '$src/db/fixtures/knee-mri-scenario.json';
import visionScreeningScenario from '$src/db/fixtures/vision-screening-scenario.json';

export interface AppOptions extends Partial<Config> {
  policy?: SchedulePolicy;
  skipAutoRun?: boolean;  // Explicitly control autoRun resumption
}

export class App {
  readonly configManager: ConfigManager;
  readonly storage: Storage;
  readonly orchestrator: OrchestratorService;
  readonly llmProviderManager: LLMProviderManager;
  readonly agentHost: AgentHost;

  constructor(options?: AppOptions) {
    const { policy, skipAutoRun, ...configOverrides } = options || {};
    this.configManager = new ConfigManager(configOverrides);
    this.storage = new Storage(this.configManager.dbPath);
    const config = this.configManager.get();
    this.llmProviderManager = new LLMProviderManager({
      defaultLlmProvider: config.defaultLlmProvider,
      defaultLlmModel: config.defaultLlmModel,
      googleApiKey: config.googleApiKey,
      openRouterApiKey: config.openRouterApiKey
    });
    this.orchestrator = new OrchestratorService(
      this.storage,
      undefined, // Use default subscription bus
      policy, // Use provided policy or default
      this.configManager.orchestratorConfig
    );
    this.agentHost = new AgentHost(this.orchestrator, this.llmProviderManager);
    
    // Seed default scenarios on startup (no-op if already present)
    this.seedDefaultScenarios();
    
    // Resume any autoRun conversations post-restart
    const shouldSkipAutoRun = skipAutoRun ?? (this.configManager.get().nodeEnv === 'test');
    if (!shouldSkipAutoRun) {
      // Fire and forget; resume ensures idempotency
      resumeActiveConversations(this.orchestrator, this.agentHost).catch(err => {
        console.error('[App] Failed to resume active conversations', err);
      });
    }
  }

  private seedDefaultScenarios() {
    // Don't seed in test environment to avoid polluting test databases
    if (this.configManager.get().nodeEnv === 'test') {
      return;
    }

    const scenarios: ScenarioConfiguration[] = [
      kneeMriScenario as ScenarioConfiguration,
      visionScreeningScenario as ScenarioConfiguration,
    ];

    for (const scenario of scenarios) {
      const id = scenario.metadata.id;
      const name = scenario.metadata.title;
      
      try {
        // Check if scenario already exists
        const existing = this.storage.scenarios.findScenarioById(id);
        
        if (!existing) {
          // Insert new scenario
          this.storage.scenarios.insertScenario({
            id,
            name,
            config: scenario,
            history: []
          });
          console.log(`[App] Seeded scenario: ${id} - ${name}`);
        }
      } catch (error) {
        console.error(`[App] Failed to seed scenario ${id}:`, error);
      }
    }
  }

  // No per-App resume method; handled by AgentHost resume helper

  async shutdown() {
    await this.orchestrator.shutdown();
    this.storage.close();
  }
}
