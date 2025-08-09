export interface AgentMeta {
  id: string;                              // slug, immutable (matches agentId from scenario)
  agentClass?: string;                     // e.g., "AssistantAgent", "EchoAgent", "ScriptAgent"
  role?: string;
  displayName?: string;
  avatarUrl?: string;
  config?: Record<string, unknown>;        // agent-specific configuration (e.g., LLM provider settings)
}

export interface ConversationMeta {
  // Core fields
  title?: string;
  description?: string;
  scenarioId?: string;
  
  // Agent configuration
  agents: AgentMeta[];
  startingAgentId?: string;                // which agent should start the conversation
  
  // Configuration
  config?: Record<string, unknown>;
  custom?: Record<string, unknown>;        // namespaced ext
  
  // Versioning
  metaVersion?: number;                    // defaults to 1 if not specified
}

// For creating conversations - now requires full meta object
export interface CreateConversationRequest {
  meta: ConversationMeta;
}
