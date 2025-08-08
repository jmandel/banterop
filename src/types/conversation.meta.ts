export interface AgentMeta {
  id: string;                              // slug, immutable (matches agentId from scenario)
  kind: 'internal' | 'external';           // explicitly specify if internal or external
  agentClass?: string;                     // e.g., "AssistantAgent", "EchoAgent", "ScriptAgent"
  role?: string;
  displayName?: string;
  avatarUrl?: string;
  config?: Record<string, unknown>;        // agent-specific configuration (e.g., LLM provider settings)
}

export interface ConversationMeta {
  title?: string;
  description?: string;
  scenarioId?: string;
  agents: AgentMeta[];
  startingAgentId?: string;                // which agent should start the conversation
  config?: Record<string, unknown>;
  custom?: Record<string, unknown>;        // namespaced ext
}

// For creating conversations
export interface CreateConversationRequest {
  title?: string;
  description?: string;
  scenarioId?: string;
  agents?: AgentMeta[];
  startingAgentId?: string;                // which agent should start the conversation
  config?: Record<string, unknown>;
  custom?: Record<string, unknown>;
}