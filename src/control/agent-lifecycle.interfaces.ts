import type { AgentRuntimeInfo } from '$src/agents/factories/agent.factory';

/**
 * Manages the persistent record of which agents should be running.
 */
export interface IAgentRegistry {
  register(conversationId: number, agentIds: string[]): Promise<void>;
  unregister(conversationId: number, agentIds?: string[]): Promise<void>;
  listRegistered(): Promise<Array<{ conversationId: number; agentIds: string[] }>>;
}

/**
 * Manages the live, in-memory instances of running agents.
 */
export interface IAgentHost {
  ensure(conversationId: number, opts?: { agentIds?: string[] }): Promise<void>;
  stop(conversationId: number): Promise<void>;
  list(conversationId: number): AgentRuntimeInfo[];
  stopAll(): Promise<void>;
}

/**
 * The unified public API for managing agent lifecycles.
 * Coordinates between a registry (persistence) and a host (runtime).
 */
export interface IAgentLifecycleManager {
  ensure(conversationId: number, agentIds: string[]): Promise<{ ensured: AgentRuntimeInfo[] }>;
  stop(conversationId: number, agentIds?: string[]): Promise<void>;
  resumeAll(): Promise<void>;
  listRuntime(conversationId: number): AgentRuntimeInfo[];
  clearOthers(keepConversationId: number): Promise<void>;
}
