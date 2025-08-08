import type { Agent, AgentContext } from '$src/agents/agent.types';
import type { AgentConfiguration, ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import type { LLMMessage, LLMProvider } from '$src/types/llm.types';
import type { UnifiedEvent } from '$src/types/event.types';
import type { HydratedConversationSnapshot } from '$src/types/orchestrator.types';
import type { ScenarioDrivenAgentOptions } from './scenario-driven.types';
import type { ProviderManager } from '$src/llm/provider-manager';
import type { SupportedProvider } from '$src/types/llm.types';
import type { AgentMeta } from '$src/types/conversation.meta';

export interface ScenarioDrivenAgentConfig {
  agentId: string;
  providerManager: ProviderManager;
  options?: ScenarioDrivenAgentOptions;
}

/**
 * Scenario-driven internal agent (MVP).
 * - Single-step: builds a prompt from scenario persona + conversation history
 * - Produces one assistant message with finality='turn'
 * - Future: optional traces/tool synthesis with Oracle
 */
export class ScenarioDrivenAgent implements Agent {
  private providerManager: ProviderManager;
  // TODO: Implement multi-step support
  // private maxSteps: number;
  // TODO: Implement oracle/tool synthesis
  // private useOracle: boolean;

  constructor(cfg: ScenarioDrivenAgentConfig) {
    this.providerManager = cfg.providerManager;
    // TODO: Implement multi-step and oracle support
    // this.maxSteps = cfg.options?.maxStepsPerTurn ?? 1;
    // this.useOracle = cfg.options?.useOracle ?? false;
  }

  async handleTurn(ctx: AgentContext): Promise<void> {
    const { conversationId, agentId, client, logger } = ctx;

    // Get snapshot (will be hydrated for internal agents)
    const hydrated = await client.getSnapshot(conversationId) as HydratedConversationSnapshot;
    
    if (!hydrated.scenario) {
      throw new Error(`Conversation ${conversationId} lacks scenario configuration`);
    }

    const scenario: ScenarioConfiguration = hydrated.scenario;
    
    // Find my agent configuration in the scenario
    const myAgent = scenario.agents.find(a => a.agentId === agentId);
    if (!myAgent) {
      throw new Error(`Agent ${agentId} not found in scenario configuration`);
    }

    // Get LLM provider - check for agent-specific config first
    const provider = this.getProviderForAgent(hydrated, agentId);
    
    // Build LLM messages from scenario persona and conversation history
    const messages = this.buildMessages(agentId, myAgent, scenario, hydrated.events);

    logger.info(`ScenarioDrivenAgent(${agentId}) starting turn with ${provider.getMetadata().name} provider`);

    // Single-step completion
    const response = await provider.complete({ messages });

    // TODO: If useOracle is true and response contains tool calls:
    // 1. Parse tool calls from response
    // 2. Call ToolSynthesisService for each tool
    // 3. Post trace events for thought/tool_call/tool_result
    // 4. Build final message with attachments

    const text = response.content?.trim() || '...';
    
    // Check if any tools should end the conversation
    // TODO: Parse tool calls and check endsConversation flag
    const finality = 'turn'; // Default to turn, would be 'conversation' if tool ends it

    await client.postMessage({
      conversationId,
      agentId,
      text,
      finality,
    });

    logger.info(`ScenarioDrivenAgent(${agentId}) completed turn`);
  }

  private getProviderForAgent(hydrated: HydratedConversationSnapshot, agentId: string): LLMProvider {
    // Check for runtime agent configuration
    const runtimeAgent = hydrated.runtimeMeta?.agents?.find((a: AgentMeta) => a.id === agentId);
    
    if (runtimeAgent?.config?.llmProvider) {
      // Use agent-specific provider config
      const providerName = runtimeAgent.config.llmProvider as string;
      const model = runtimeAgent.config.model as string | undefined;
      return this.providerManager.getProvider({ 
        provider: providerName as SupportedProvider,
        ...(model !== undefined ? { model } : {})
      });
    }
    
    // Fall back to system default
    return this.providerManager.getProvider();
  }

  private buildMessages(
    myAgentId: string,
    myAgent: AgentConfiguration,
    scenario: ScenarioConfiguration,
    events: UnifiedEvent[]
  ): LLMMessage[] {
    // System prompt synthesizes persona + situation + goals
    const systemParts: string[] = [];
    
    // Core persona
    systemParts.push(myAgent.systemPrompt);
    
    // Add context about the principal
    systemParts.push(`\nYou are playing the role of ${myAgent.principal.name} - ${myAgent.principal.description}`);
    
    // Add situation
    if (myAgent.situation) {
      systemParts.push(`\nSituation: ${myAgent.situation}`);
    }
    
    // Add goals
    if (myAgent.goals?.length) {
      systemParts.push(`\nYour goals:`);
      systemParts.push(myAgent.goals.map(g => `- ${g}`).join('\n'));
    }
    
    // Add scenario context
    systemParts.push(`\nScenario: ${scenario.metadata.title}`);
    systemParts.push(`Background: ${scenario.scenario.background}`);
    
    // Add knowledge base context if present
    if (myAgent.knowledgeBase && Object.keys(myAgent.knowledgeBase).length > 0) {
      systemParts.push(`\nAvailable knowledge:`);
      for (const [key, value] of Object.entries(myAgent.knowledgeBase)) {
        systemParts.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    
    // Add tool descriptions if present
    if (myAgent.tools?.length) {
      systemParts.push(`\nAvailable tools:`);
      for (const tool of myAgent.tools) {
        systemParts.push(`- ${tool.toolName}: ${tool.description}`);
        // TODO: Add tool schema details for when we implement tool calling
      }
    }

    const messages: LLMMessage[] = [{ role: 'system', content: systemParts.join('\n') }];

    // Add conversation history as alternating user/assistant messages
    for (const event of events) {
      if (event.type !== 'message') continue;
      
      const payload = event.payload as any;
      const text = payload?.text;
      if (!text) continue;

      // Map to LLM role based on whether this was from me
      const role: 'user' | 'assistant' = event.agentId === myAgentId ? 'assistant' : 'user';
      messages.push({ role, content: text });
    }

    return messages;
  }
}