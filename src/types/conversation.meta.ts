export interface AgentMeta {
  id: string;                              // slug, immutable
  kind: 'internal' | 'external';
  role?: string;
  displayName?: string;
  avatarUrl?: string;
  config?: Record<string, unknown>;
}

export interface ConversationMeta {
  title?: string;
  description?: string;
  scenarioId?: string;
  agents: AgentMeta[];
  config?: Record<string, unknown>;
  custom?: Record<string, unknown>;        // namespaced ext
}

// For creating conversations
export interface CreateConversationRequest {
  title?: string;
  description?: string;
  scenarioId?: string;
  agents?: AgentMeta[];
  config?: Record<string, unknown>;
  custom?: Record<string, unknown>;
}