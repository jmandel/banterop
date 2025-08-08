import type { Finality, MessagePayload, TracePayload, UnifiedEvent } from './event.types';

// REST API types
export interface ListConversationsRequest {
  status?: 'active' | 'completed';
  scenarioId?: string;
  limit?: number;
  offset?: number;
}

export interface GetConversationRequest {
  conversationId: number;
  includeEvents?: boolean;
  includeAttachments?: boolean;
}

// WebSocket JSON-RPC types
export interface SubscribeRequest {
  conversationId: number;
  includeGuidance?: boolean;
  filters?: {
    types?: Array<'message' | 'trace' | 'system'>;
    agents?: string[];
  };
  sinceSeq?: number;
}

export interface SubscribeResponse {
  subId: string;
}

export interface AbortTurnRequest {
  conversationId: number;
  agentId: string;
}

export interface AbortTurnResponse {
  turn: number;
}

export interface SendTraceRequest {
  conversationId: number;
  agentId: string;
  tracePayload: TracePayload;
  turn?: number; // optional turn override for advanced clients
}

export interface SendTraceResponse {
  conversation: number;
  turn: number;
  event: number;
}

export interface SendMessageRequest {
  conversationId: number;
  agentId: string;
  messagePayload: MessagePayload; // clientRequestId must be inside this payload for idempotency
  finality: Finality;
  turn?: number; // optional turn override for advanced clients
}

export interface SendMessageResponse {
  conversation: number;
  turn: number;
  event: number;
}

export interface GetConversationResponse {
  conversation: number;
  status: 'active' | 'completed';
  events: UnifiedEvent[];
}

// JSON-RPC protocol
export interface JsonRpcRequest {
  id?: string | number;
  method: string;
  params?: unknown;
  jsonrpc?: '2.0';
}

export interface JsonRpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  jsonrpc: '2.0';
}

export interface JsonRpcNotification {
  method: string;
  params: unknown;
  jsonrpc: '2.0';
}

// New WebSocket RPC API types
export interface CreateConversationRpcResult {
  conversationId: number;
}

export interface ListConversationsRpcParams {
  status?: 'active' | 'completed';
  scenarioId?: string;
  limit?: number;
  offset?: number;
}

export interface ListConversationsRpcResult {
  conversations: import('$src/db/conversation.store').Conversation[];
}

export interface GetEventsPageParams {
  conversationId: number;
  afterSeq?: number;
  limit?: number;
}

export interface GetEventsPageResult {
  events: UnifiedEvent[];
  nextAfterSeq?: number;
}

// Scenario RPC types
export interface CreateScenarioRpcParams {
  id: string;
  name: string;
  config: import('$src/types/scenario-configuration.types').ScenarioConfiguration;
  history?: any[];
}

export interface GetScenarioRpcParams {
  scenarioId: string;
}

export interface UpdateScenarioRpcParams {
  id: string;
  name?: string;
  config?: import('$src/types/scenario-configuration.types').ScenarioConfiguration;
}

export interface DeleteScenarioRpcParams {
  id: string;
}