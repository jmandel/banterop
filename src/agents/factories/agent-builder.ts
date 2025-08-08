import type { Agent } from '$src/agents/agent.types';
import type { AgentMeta } from '$src/types/conversation.meta';
import type { ProviderManager } from '$src/llm/provider-manager';
import type { Storage } from '$src/server/orchestrator/storage';
import { EchoAgent } from '$src/agents/echo.agent';
import { AssistantAgent } from '$src/agents/assistant.agent';
import { ScenarioDrivenAgent } from '$src/agents/scenario/scenario-driven.agent';
import { TestAgent } from '$src/agents/test-agent';

export interface BuildAgentContext {
  providerManager: ProviderManager;
  storage: Storage;
}

/**
 * Build an agent instance based on metadata
 * This function creates a fresh agent instance for each turn
 */
export function buildAgent(meta: AgentMeta, context: BuildAgentContext): Agent {
  console.log('[buildAgent] Building agent with meta:', JSON.stringify(meta));
  
  // Check agentClass first for explicit type
  if (meta.agentClass) {
    switch (meta.agentClass) {
      case 'TestAgent':
        console.log('[buildAgent] Creating TestAgent with config:', meta.config);
        return new TestAgent(meta.config as any);
      
      case 'EchoAgent':
        return new EchoAgent(
          meta.config?.progressText as string ?? 'Processing...',
          meta.config?.finalText as string ?? 'Done'
        );
      
      case 'AssistantAgent':
        const provider = context.providerManager.getProvider(
          meta.config?.llmProvider as any
        );
        return new AssistantAgent(provider);
      
      case 'ScenarioDrivenAgent':
        return new ScenarioDrivenAgent({
          agentId: meta.id,
          providerManager: context.providerManager,
          options: meta.config?.options as any,
        });
      
      default:
        throw new Error(`Unknown agent class: ${meta.agentClass}`);
    }
  }
  
  // Fall back to role-based selection
  switch (meta.role) {
    case 'scenario':
      return new ScenarioDrivenAgent({
        agentId: meta.id,
        providerManager: context.providerManager,
        options: meta.config?.options as any,
      });
    
    case 'assistant':
      const assistantProvider = context.providerManager.getProvider(
        meta.config?.llmProvider as any
      );
      return new AssistantAgent(assistantProvider);
    
    case 'echo':
      return new EchoAgent(
        meta.config?.progressText as string ?? 'Processing...',
        meta.config?.finalText as string ?? 'Done'
      );
    
    default:
      // Default to echo agent if no specific type
      return new EchoAgent();
  }
}