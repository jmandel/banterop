import type { StreamEvent } from '$src/agents/clients/event-stream';
import type { MessagePayload, TracePayload } from '$src/types/event.types';
import type { ConversationSnapshot, HydratedConversationSnapshot } from '$src/types/orchestrator.types';

export interface IAgentTransport {
  getSnapshot(conversationId: number, opts?: { includeScenario?: boolean }): Promise<ConversationSnapshot | HydratedConversationSnapshot>;
  
  postMessage(params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: NonNullable<MessagePayload['attachments']>;
    clientRequestId?: string;
    turn?: number;
    precondition?: { lastClosedSeq: number };
  }): Promise<{ seq: number; turn: number; event: number }>;
  
  postTrace(params: {
    conversationId: number;
    agentId: string;
    payload: TracePayload;
    turn?: number;
    clientRequestId?: string;
    precondition?: { lastClosedSeq: number };
  }): Promise<{ seq: number; turn: number; event: number }>;
  
  now(): number;
}

export interface IAgentEvents {
  subscribe(listener: (ev: StreamEvent) => void): () => void; // returns unsubscribe function
}