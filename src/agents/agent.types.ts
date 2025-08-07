import type { TracePayload } from '$src/types/event.types';

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
  // Reads
  getSnapshot(conversationId: number): Promise<{ 
    conversation: number; 
    status: 'active' | 'completed'; 
    events: any[] 
  }>;
  
  // Writes
  postMessage(params: { 
    conversationId: number; 
    agentId: string; 
    text: string; 
    finality: 'none' | 'turn' | 'conversation'; 
    attachments?: Array<{ 
      id?: string; 
      docId?: string; 
      name: string; 
      contentType: string; 
      content?: string; 
      summary?: string 
    }>; 
    clientRequestId?: string; 
    turnHint?: number 
  }): Promise<{ 
    seq: number; 
    turn: number; 
    event: number 
  }>;
  
  postTrace(params: { 
    conversationId: number; 
    agentId: string; 
    payload: TracePayload; 
    turn?: number; 
    clientRequestId?: string 
  }): Promise<{ 
    seq: number; 
    turn: number; 
    event: number 
  }>;

  now(): Date;
}

export interface Logger {
  debug(msg: string, meta?: any): void;
  info(msg: string, meta?: any): void;
  warn(msg: string, meta?: any): void;
  error(msg: string, meta?: any): void;
}