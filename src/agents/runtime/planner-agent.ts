import { BaseAgent, type TurnContext, type TurnRecoveryMode } from './base-agent';
import type { IAgentTransport } from './runtime.interfaces';
import type { ConversationSnapshot } from '$src/types/orchestrator.types';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import { ScenarioPlanner } from '$src/frontend/client/planner-scenario';
import { AttachmentVault } from '$src/frontend/client/attachments-vault';
import type { LLMProvider } from '$src/types/llm.types';
import type { UnifiedEvent as StrictEvent } from '$src/frontend/client/types/events';
import { logLine } from '$src/lib/utils/logger';

export interface PlannerAgentConfig {
  agentId: string;
  providerManager: any; // LLMProviderManager - will import later
  options?: {
    turnRecoveryMode?: TurnRecoveryMode;
  };
}

export interface ToolRestriction {
  omitCoreTools?: string[];    // Core communication tools to exclude
  omitScenarioTools?: string[]; // Scenario-specific tools to exclude
}

/**
 * PlannerBackedAgent that subclasses BaseAgent and uses ScenarioPlanner
 * for all execution logic, eliminating code duplication.
 */
export class PlannerAgent extends BaseAgent<ConversationSnapshot> {
  private providerManager: any;
  private attachmentVault: AttachmentVault;
  private toolRestrictions: ToolRestriction = {};

  constructor(
    transport: IAgentTransport,
    cfg: PlannerAgentConfig
  ) {
    super(transport, cfg.options);
    this.providerManager = cfg.providerManager;
    this.attachmentVault = new AttachmentVault();
  }

  protected async takeTurn(ctx: TurnContext<ConversationSnapshot>): Promise<void> {
    const { conversationId, agentId } = ctx;

    try {
      // 1. Convert BaseAgent context to planner event log
      const plannerEvents = this.convertSnapshotToPlannerEvents(ctx.snapshot, ctx.agentId);

      // 2. Extract scenario configuration
      const plannerScenario = this.extractPlannerScenario(ctx.snapshot, ctx.agentId);

      // 3. Create planner with direct scenario JSON (eliminates API base dependency)
      const plannerInstance = new ScenarioPlanner({
        // Task client not needed in backend
        task: null,
        // API base and endpoint not needed when passing scenario JSON directly
        getApiBase: undefined,
        getEndpoint: () => '',
        getPlannerAgentId: () => ctx.agentId,
        getCounterpartAgentId: () => this.getCounterpartAgentId(ctx),
        getAdditionalInstructions: () => undefined,
        getScenarioConfig: () => this.extractPlannerScenario(ctx.snapshot, ctx.agentId),
        getLLMProvider: () => this.getLLMProvider(ctx),
        vault: this.attachmentVault,
        getToolRestrictions: () => this.toolRestrictions,
        getEnabledTools: () => this.getFilteredScenarioTools(ctx.snapshot),
        // UI callbacks not needed in backend
        onSystem: () => {},
        onAskUser: () => {},
        onPlannerThinking: () => {}
      });

      // 4. Load events and start planner
      plannerInstance.loadEvents(plannerEvents);
      plannerInstance.start();

      // 5. Monitor for completion
      const unsubscribe = this.monitorPlannerEvents(ctx, plannerInstance);

      try {
        await this.waitForPlannerCompletion(plannerInstance);
      } finally {
        unsubscribe();
      }

    } catch (error) {
      logLine(agentId, 'error', `Error in PlannerAgent.takeTurn: ${error}`);
      // Send error message via transport
      await ctx.transport.postMessage({
        conversationId,
        agentId,
        text: "I encountered an unexpected error. Please try again later.",
        finality: 'turn',
        turn: ctx.currentTurnNumber || 0
      });
    }
  }

  /**
   * Convert BaseAgent conversation snapshot to planner event log
   */
  private convertSnapshotToPlannerEvents(
    snapshot: ConversationSnapshot,
    myAgentId: string
  ): StrictEvent[] {
    const events: StrictEvent[] = [];

    // Convert existing conversation events
    for (const event of snapshot.events) {
      if (event.type === 'message') {
        const channel = event.agentId === myAgentId ? 'planner-agent' : 'user-planner';
        const author = event.agentId === myAgentId ? 'planner' : 'agent';

        // Handle timestamp conversion (event.ts might be Date or string)
        const timestamp = new Date(String(event.ts)).toISOString();

        events.push({
          seq: event.seq,
          timestamp,
          type: 'message',
          channel,
          author,
          payload: {
            text: (event.payload as any).text,
            attachments: (event.payload as any).attachments?.map((att: any) => ({
              name: att.name,
              mimeType: att.contentType,
              bytes: att.content ? btoa(att.content) : undefined
            }))
          }
        });
      }
    }

    // Add synthetic "remote message arrived" event to trigger planner action
    events.push({
      seq: events.length > 0 ? Math.max(...events.map(e => e.seq)) + 1 : 1,
      timestamp: new Date().toISOString(),
      type: 'message',
      channel: 'user-planner',
      author: 'agent',
      payload: {
        text: 'Please continue our conversation...',
        attachments: []
      }
    });

    return events;
  }

  /**
   * Extract scenario configuration from snapshot
   */
  private extractPlannerScenario(
    snapshot: ConversationSnapshot,
    myAgentId: string
  ): ScenarioConfiguration | null {
    if (!snapshot.scenario) {
      return null;
    }

    // Find our agent configuration
    const myAgentConfig = snapshot.scenario.agents.find(a => a.agentId === myAgentId);
    if (!myAgentConfig) {
      return null;
    }

    // Create minimal scenario config for planner
    return {
      metadata: snapshot.scenario.metadata,
      agents: [myAgentConfig]
    };
  }

  /**
   * Get filtered scenario tools based on context
   */
  private getFilteredScenarioTools(snapshot: ConversationSnapshot): any[] {
    if (!snapshot.scenario) return [];

    const myAgentConfig = snapshot.scenario.agents.find(a =>
      a.agentId === this.providerManager?.agentId || 'planner-agent'
    );

    if (!myAgentConfig?.tools) return [];

    return myAgentConfig.tools.map(tool => ({
      name: tool.toolName,
      description: tool.description,
      synthesisGuidance: tool.synthesisGuidance,
      inputSchema: tool.inputSchema,
      endsConversation: tool.endsConversation,
      conversationEndStatus: tool.conversationEndStatus
    }));
  }

  /**
   * Get LLM provider for this context
   */
  private getLLMProvider(ctx: TurnContext<ConversationSnapshot>): LLMProvider {
    // Get agent-specific config if available
    const runtimeAgent = ctx.snapshot.runtimeMeta?.agents?.find((a: any) => a.id === ctx.agentId);
    const model = (runtimeAgent?.config?.model as string) || undefined;

    return this.providerManager.getProvider({ model });
  }

  /**
   * Monitor planner events and convert to BaseAgent transport calls
   */
  private monitorPlannerEvents(ctx: TurnContext<ConversationSnapshot>, planner: ScenarioPlanner) {
    return (planner as any).onEvent((event: StrictEvent) => {
      if (event.type === 'message' && event.channel === 'planner-agent') {
        // Type guard for message payload
        if (event.payload && typeof event.payload === 'object' && 'text' in event.payload) {
          const messagePayload = event.payload as { text: string; attachments?: any[] };

          // Convert to BaseAgent transport call
          ctx.transport.postMessage({
            conversationId: ctx.conversationId,
            agentId: ctx.agentId,
            text: messagePayload.text,
            finality: 'turn',
            attachments: messagePayload.attachments?.map(att => ({
              name: att.name,
              contentType: att.mimeType,
              content: att.bytes ? atob(att.bytes) : undefined
            })),
            turn: ctx.currentTurnNumber || 0
          });
        }
      }

      if (event.type === 'tool_call') {
        // Type guard for tool_call payload
        if (event.payload && typeof event.payload === 'object' && 'name' in event.payload && 'args' in event.payload) {
          const toolCallPayload = event.payload as { name: string; args: any };

          // Forward trace to orchestrator
          ctx.transport.postTrace({
            conversationId: ctx.conversationId,
            agentId: ctx.agentId,
            payload: {
              type: 'tool_call',
              name: toolCallPayload.name,
              args: toolCallPayload.args,
              toolCallId: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            },
            turn: ctx.currentTurnNumber || 0
          });
        }
      }
    });
  }

  /**
   * Wait for planner completion with timeout
   */
  private async waitForPlannerCompletion(planner: ScenarioPlanner): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Planner timeout after 30 seconds'));
      }, 30000);

      const unsubscribe = (planner as any).onEvent((event: StrictEvent) => {
        if (event.type === 'message' && event.channel === 'planner-agent') {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    });
  }

  /**
   * Set tool restrictions for this planner instance
   */
  public setToolRestrictions(restrictions: ToolRestriction): void {
    this.toolRestrictions = restrictions;
  }

  /**
   * Get the counterpart agent ID for this conversation
   */
  private getCounterpartAgentId(ctx: TurnContext<ConversationSnapshot>): string | undefined {
    if (!ctx.snapshot.scenario) return undefined;

    // Find other agents in the scenario (excluding ourselves)
    const otherAgents = ctx.snapshot.scenario.agents.filter(a => a.agentId !== ctx.agentId);
    return otherAgents[0]?.agentId;
  }
}
