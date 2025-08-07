import { Storage } from './orchestrator/storage';
import { OrchestratorService } from './orchestrator/orchestrator';
import { ConfigManager, type Config } from './config';

export class App {
  readonly config: ConfigManager;
  readonly storage: Storage;
  readonly orchestrator: OrchestratorService;

  constructor(configOverrides?: Partial<Config>) {
    this.config = new ConfigManager(configOverrides);
    this.storage = new Storage(this.config.dbPath);
    this.orchestrator = new OrchestratorService(
      this.storage,
      undefined, // Use default subscription bus
      undefined, // Use default policy
      this.config.orchestratorConfig
    );
  }

  async shutdown() {
    await this.orchestrator.shutdown();
    this.storage.close();
  }
}