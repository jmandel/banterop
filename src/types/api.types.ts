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
export interface AuthenticateRequest {
  token: string;
}

export interface AuthenticateResponse {
  authenticated: boolean;
  agentId?: string;
}

export interface SubscribeRequest {
  conversationId: number;
  filters?: {
    types?: Array<'message' | 'trace' | 'system'>;
    agents?: string[];
  };
}

export interface SubscribeResponse {
  subId: string;
}

export interface SendTraceRequest {
  conversationId: number;
  currentTurn?: number;
  tracePayload: TracePayload;
}

export interface SendTraceResponse {
  conversation: number;
  turn: number;
  event: number;
}

export interface SendMessageRequest {
  conversationId: number;
  currentTurn?: number;
  messagePayload: MessagePayload;
  finality: Finality;
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

export interface TailEventsRequest {
  conversationId: number;
  sinceEvent?: number;
  sinceTs?: string;
}

// Turn claim API types
export interface ClaimTurnRequest {
  conversationId: number;
  agentId: string;
  guidanceSeq: number;
}

export interface ClaimTurnResponse {
  ok: boolean;
  reason?: string; // e.g., "already claimed", "expired guidance"
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