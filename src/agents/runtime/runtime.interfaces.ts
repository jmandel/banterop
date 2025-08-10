import type { StreamEvent } from '$src/agents/clients/event-stream';
import type { MessagePayload, TracePayload } from '$src/types/event.types';
import type { ConversationSnapshot } from '$src/types/orchestrator.types';

export interface IAgentTransport {
  getSnapshot(conversationId: number, opts?: { includeScenario?: boolean }): Promise<ConversationSnapshot>;
  
  clearTurn(conversationId: number, agentId: string): Promise<{ turn: number }>;
  
  postMessage(params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: NonNullable<MessagePayload['attachments']>;
    clientRequestId?: string;
    turn?: number;
  }): Promise<{ seq: number; turn: number; event: number }>;
  
  postTrace(params: {
    conversationId: number;
    agentId: string;
    payload: TracePayload;
    turn?: number;
    clientRequestId?: string;
  }): Promise<{ seq: number; turn: number; event: number }>;
  
  now(): number;
  
  // NEW: Transport owns event stream creation
  createEventStream(conversationId: number, includeGuidance: boolean): IAgentEvents;
}

export interface IAgentEvents {
  subscribe(listener: (ev: StreamEvent) => void): () => void; // returns unsubscribe function
}