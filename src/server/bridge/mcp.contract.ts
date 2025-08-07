export type ConversationId = number;
export type SeqCursor = number;

export interface PublicMessage {
  conversationId: ConversationId;
  turn: number;
  event: number;
  seq: SeqCursor;
  ts: string;
  agentId: string;
  text: string;
  finality: 'none' | 'turn' | 'conversation';
  attachments?: Array<{ 
    id: string; 
    name: string; 
    contentType: string; 
    summary?: string; 
    docId?: string 
  }>;
  outcome?: { 
    status: 'success' | 'failure' | 'neutral'; 
    reason?: string; 
    codes?: string[] 
  };
}

export interface BeginChatThreadRequest {
  title?: string;
  description?: string;
}

export interface BeginChatThreadResponse {
  conversationId: ConversationId;
  latestSeq: SeqCursor;
  status: 'active' | 'completed';
}

export interface PostMessageRequest {
  conversationId: ConversationId;
  text: string;
  finality?: 'turn' | 'conversation' | 'none';
  attachments?: Array<{ 
    name: string; 
    contentType: string; 
    content: string; 
    summary?: string; 
    docId?: string 
  }>;
  clientRequestId?: string;
}

export interface PostMessageResponse {
  conversationId: ConversationId;
  turn: number;
  event: number;
  seq: SeqCursor;
  ts: string;
}

export interface WaitForUpdatesRequest {
  conversationId: ConversationId;
  sinceSeq?: SeqCursor;
  limit?: number;
  timeoutMs?: number; // 0 = immediate; >0 = long-poll
  agentId?: string;   // optional, reserved for future
}

export interface WaitForUpdatesResponse {
  conversationId: ConversationId;
  latestSeq: SeqCursor;
  status: 'active' | 'completed';
  messages: PublicMessage[];
  guidance: 'you_may_speak' | 'wait' | 'closed' | 'unknown';
  note?: string;
  timedOut: boolean;
}