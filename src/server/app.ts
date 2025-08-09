import { Storage } from './orchestrator/storage';
import { OrchestratorService } from './orchestrator/orchestrator';
import { ConfigManager, type Config } from './config';
import { LLMProviderManager } from '$src/llm/provider-manager';
import type { SchedulePolicy } from '$src/types/orchestrator.types';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import { startAgents } from '$src/agents/factories/agent.factory';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
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
    
    // Seed default scenarios on startup (no-op if already present)
    this.seedDefaultScenarios();
    
    // Resume any autoRun conversations post-restart
    // Skip if explicitly disabled or in test mode (unless explicitly enabled)
    const shouldSkipAutoRun = skipAutoRun ?? (this.configManager.get().nodeEnv === 'test');
    if (!shouldSkipAutoRun) {
      this.resumeAutoRunConversations();
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

  private resumeAutoRunConversations(maxAgeHours = 6) {
    const cutoffIso = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
    const activeConvos = this.storage.conversations.list({ status: 'active' });

    for (const convo of activeConvos) {
      const meta = convo.metadata;
      const autoRun = meta.custom?.autoRun;
      if (autoRun) {
        if (convo.updatedAt < cutoffIso) {
          console.warn(`[AutoRun Resume] Skipping ${convo.conversation} — last updated too old (${convo.updatedAt})`);
          meta.custom = { ...(meta.custom || {}), autoRun: false };
          this.storage.conversations.updateMeta(convo.conversation, meta);
          continue;
        }
        console.log(`[AutoRun Resume] Resuming conversation ${convo.conversation}`);
        
        // Only start if there are internal agents defined
        const hasInternalAgents = meta.agents?.some((a: any) => a.kind === 'internal');
        if (hasInternalAgents) {
          startAgents({
            conversationId: convo.conversation,
            transport: new InProcessTransport(this.orchestrator),
            providerManager: this.llmProviderManager
          }).catch(err => {
            console.error(`[AutoRun Resume] Failed to start convo ${convo.conversation}`, err);
          });
        }
      }
    }
  }

  async shutdown() {
    await this.orchestrator.shutdown();
    this.storage.close();
  }
}