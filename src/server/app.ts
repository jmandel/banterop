import { Storage } from './orchestrator/storage';
import { OrchestratorService } from './orchestrator/orchestrator';
import { ConfigManager, type Config } from './config';
import { ProviderManager } from '$src/llm/provider-manager';
import type { SchedulePolicy } from '$src/types/orchestrator.types';
import { startAgents } from '$src/agents/factories/agent.factory';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';

export interface AppOptions extends Partial<Config> {
  policy?: SchedulePolicy;
  skipAutoRun?: boolean;  // Explicitly control autoRun resumption
}

export class App {
  readonly config: ConfigManager;
  readonly storage: Storage;
  readonly orchestrator: OrchestratorService;
  readonly providerManager: ProviderManager;

  constructor(options?: AppOptions) {
    const { policy, skipAutoRun, ...configOverrides } = options || {};
    this.config = new ConfigManager(configOverrides);
    this.storage = new Storage(this.config.dbPath);
    this.providerManager = new ProviderManager(this.config.get());
    this.orchestrator = new OrchestratorService(
      this.storage,
      undefined, // Use default subscription bus
      policy, // Use provided policy or default
      this.config.orchestratorConfig
    );
    
    // Resume any autoRun conversations post-restart
    // Skip if explicitly disabled or in test mode (unless explicitly enabled)
    const shouldSkipAutoRun = skipAutoRun ?? (this.config.get().nodeEnv === 'test');
    if (!shouldSkipAutoRun) {
      this.resumeAutoRunConversations();
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
            providerManager: this.providerManager
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