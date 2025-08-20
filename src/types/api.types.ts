import type { Finality, MessagePayload, TracePayload, UnifiedEvent } from './event.types';

// REST API types (legacy request shapes removed)

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

export interface clearTurnRequest {
  conversationId: number;
  agentId: string;
}

export interface clearTurnResponse {
  turn: number;
}

export interface SendTraceRequest {
  conversationId: number;
  agentId: string;
  tracePayload: TracePayload;
  turn: number; // Required turn number for explicit turn management
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
  turn: number; // Required turn number for explicit turn management
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


export interface GetEventsPageParams {
  conversationId: number;
  afterSeq?: number;
  limit?: number;
}

export interface GetEventsPageResult {
  events: UnifiedEvent[];
  nextAfterSeq?: number;
}

// Scenario RPC legacy param types removed
