import { Storage } from './orchestrator/storage';
import { OrchestratorService } from './orchestrator/orchestrator';
import { ConfigManager, type Config } from './config';
import { ProviderManager } from '$src/llm/provider-manager';
import type { SchedulePolicy } from '$src/types/orchestrator.types';

export interface AppOptions extends Partial<Config> {
  policy?: SchedulePolicy;
}

export class App {
  readonly config: ConfigManager;
  readonly storage: Storage;
  readonly orchestrator: OrchestratorService;
  readonly providerManager: ProviderManager;

  constructor(options?: AppOptions) {
    const { policy, ...configOverrides } = options || {};
    this.config = new ConfigManager(configOverrides);
    this.storage = new Storage(this.config.dbPath);
    this.providerManager = new ProviderManager(this.config.get());
    this.orchestrator = new OrchestratorService(
      this.storage,
      undefined, // Use default subscription bus
      policy, // Use provided policy or default
      this.config.orchestratorConfig
    );
  }

  async shutdown() {
    await this.orchestrator.shutdown();
    this.storage.close();
  }
}