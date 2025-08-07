export type Finality = 'none' | 'turn' | 'conversation';
export type EventType = 'message' | 'trace' | 'system';

export interface UnifiedEvent<TPayload = unknown> {
  conversation: number;
  turn: number;
  event: number;
  type: EventType;
  payload: TPayload;
  finality: Finality;
  ts: string; // ISO
  agentId: string;
  seq: number; // global order
}

export interface MessagePayload {
  text: string;
  attachments?: Array<{
    id?: string;
    docId?: string;
    name: string;
    contentType: string;
    content?: string;
    summary?: string;
  }>;
  outcome?: { 
    status: 'success' | 'failure' | 'neutral'; 
    reason?: string; 
    codes?: string[] 
  };
  clientRequestId?: string;
}

export type TracePayload =
  | { type: 'thought'; content: string }
  | { type: 'tool_call'; name: string; args: unknown; toolCallId: string }
  | { type: 'tool_result'; toolCallId: string; result?: unknown; error?: string }
  | { type: 'user_query'; question: string; context?: unknown; clientRequestId?: string }
  | { type: 'user_response'; queryId: string; response: string };

export interface SystemPayload {
  kind: 'idle_timeout' | 'note' | 'next_candidate_agents' | 'policy_hint';
  data?: unknown;
}

export interface AppendEventInput<T = unknown> {
  tenantId?: string;
  conversation: number;
  turn?: number; // optional for message starting a new turn
  type: EventType;
  payload: T;
  finality: Finality;
  agentId: string;
}

export interface AppendEventResult {
  conversation: number;
  turn: number;
  event: number;
  seq: number;
  ts: string;
}

export interface AttachmentRow {
  id: string;
  conversation: number;
  turn: number;
  event: number;
  docId?: string;
  name: string;
  contentType: string;
  content: string;
  summary?: string;
  createdByAgentId: string;
  createdAt: string;
}