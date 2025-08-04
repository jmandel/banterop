// API Request/Response Types
// This file contains all API-related type definitions

import type { AttachmentPayload, Conversation, TraceEntry, ConversationEvent } from './conversation.types.js';
import type { AgentConfig } from './agent.types.js';
import type { ScenarioItem } from './scenario.types.js';

// ============= API Request/Response Types =============

export interface CreateConversationRequest {
  metadata: {
    scenarioId?: string;
    conversationTitle?: string;
    conversationDescription?: string;
  };
  agents: AgentConfig[];
}

export interface CreateConversationResponse {
  conversation: Conversation;
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
  entry: Omit<TraceEntry, 'id' | 'timestamp' | 'agentId'>;
}

export interface CompleteTurnRequest {
  conversationId: string;
  turnId: string;
  agentId: string;
  content: string;
  isFinalTurn?: boolean;
  metadata?: Record<string, any>;
  attachments?: AttachmentPayload[]; // Array of full attachment objects
}


export interface GetConversationRequest {
  conversationId: string;
  includeTurns?: boolean;
  includeTrace?: boolean;
  includeInProgress?: boolean;
}

export interface SubscriptionOptions {
  events?: ConversationEvent['type'][];
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
    scenarios: ScenarioItem[];
    total: number;
  };
}

export interface ScenarioResponse extends ApiResponse {
  data: ScenarioItem;
}