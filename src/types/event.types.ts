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
  | { type: 'thought'; content: string; clientRequestId?: string }
  | { type: 'tool_call'; name: string; args: unknown; toolCallId: string; clientRequestId?: string }
  | { type: 'tool_result'; toolCallId: string; result?: unknown; error?: string; clientRequestId?: string }
  | { type: 'user_query'; question: string; context?: unknown; clientRequestId?: string }
  | { type: 'user_response'; queryId: string; response: string; clientRequestId?: string };

export interface SystemPayload {
  kind: 'idle_timeout' | 'note' | 'meta_created' | 'meta_updated' | 'turn_started' | 'turn_phase_changed';
  data?: unknown;
  metadata?: unknown;  // For meta_created/meta_updated events
}

export interface AppendEventInput<T = unknown> {
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