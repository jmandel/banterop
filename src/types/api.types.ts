// API Request/Response Types
// This file contains all API-related type definitions

// ============= API Request/Response Types =============

export interface CreateConversationRequest {
  name?: string;
  agents: any[]; // AgentConfig[] - avoiding circular dependency
  managementMode?: 'internal' | 'external'; // defaults to 'internal'
  /** 
   * The ID of the agent that should send the first message. 
   * The corresponding agent's config in the `agents` array MUST have a 
   * `messageToUseWhenInitiatingConversation` defined.
   */
  initiatingAgentId?: string;
}

export interface CreateConversationResponse {
  conversation: any; // Conversation - avoiding circular dependency
  agentTokens: Record<string, string>; // agentId -> auth token
}

export interface StartTurnRequest {
  conversationId: string;
  agentId: string;
  metadata?: Record<string, any>;
}

export interface StartTurnResponse {
  turnId: string;
}

export interface AddTraceEntryRequest {
  conversationId: string;
  turnId: string;
  agentId: string;
  entry: any; // Omit<TraceEntry, 'id' | 'timestamp' | 'agentId'> - avoiding circular dependency
}

export interface CompleteTurnRequest {
  conversationId: string;
  turnId: string;
  agentId: string;
  content: string;
  isFinalTurn?: boolean;
  metadata?: Record<string, any>;
}


export interface GetConversationRequest {
  conversationId: string;
  includeTurns?: boolean;
  includeTrace?: boolean;
  includeInProgress?: boolean;
}

export interface SubscriptionOptions {
  events?: any[];  // ConversationEvent['type'][] - avoiding circular dependency
  agents?: string[];  // Subscribe to events from specific agents only
}

export interface UserQueryRequest {
  conversationId: string;
  agentId: string;
  question: string;
  context?: Record<string, any>;
  timeout?: number; // How long to wait for user response
}

export interface UserQueryResponse {
  queryId: string;
  status: 'pending' | 'answered' | 'timeout';
  response?: string;
}

export interface FormattedUserQuery {
  queryId: string;
  conversationId: string;
  agentId: string;
  question: string;
  context: Record<string, any>;
  createdAt: string;
  status: 'pending' | 'answered' | 'expired';
  timeout: number;
}

// ============= Generic API Response Types =============

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface ScenarioListResponse extends ApiResponse {
  data: {
    scenarios: any[]; // ScenarioItem[] - avoiding circular dependency
    total: number;
  };
}

export interface ScenarioResponse extends ApiResponse {
  data: any; // ScenarioItem - avoiding circular dependency
}