import type { MessagePayload, TracePayload } from '$src/types/event.types';

export interface Agent {
  handleTurn(ctx: AgentContext): Promise<void>;
}

export interface AgentContext {
  conversationId: number;
  agentId: string;
  deadlineMs: number;
  client: IAgentClient;
  logger: Logger;
}

export interface IAgentClient {
  getSnapshot(conversationId: number): Promise<{
    conversation: number;
    status: 'active' | 'completed';
    events: any[];
  }>;

  postMessage(params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: NonNullable<MessagePayload['attachments']>;
    clientRequestId?: string;
    turn?: number; // unified
  }): Promise<{ seq: number; turn: number; event: number }>;

  postTrace(params: {
    conversationId: number;
    agentId: string;
    payload: TracePayload;
    turn?: number; // unified
    clientRequestId?: string;
  }): Promise<{ seq: number; turn: number; event: number }>;

  now(): number;
}

export interface Logger {
  debug(msg: string, meta?: any): void;
  info(msg: string, meta?: any): void;
  warn(msg: string, meta?: any): void;
  error(msg: string, meta?: any): void;
}