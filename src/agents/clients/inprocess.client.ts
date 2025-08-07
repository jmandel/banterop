import type { IAgentClient } from '$src/agents/agent.types';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { TracePayload, MessagePayload } from '$src/types/event.types';

export class InProcessClient implements IAgentClient {
  constructor(private orch: OrchestratorService) {}

  async getSnapshot(conversationId: number) {
    return this.orch.getConversationSnapshot(conversationId);
  }


  async postMessage(params: { 
    conversationId: number; 
    agentId: string; 
    text: string; 
    finality: 'none' | 'turn' | 'conversation'; 
    attachments?: NonNullable<MessagePayload['attachments']>; 
    clientRequestId?: string; 
    turnHint?: number 
  }) {
    const payload: MessagePayload = { text: params.text };
    if (params.attachments) payload.attachments = params.attachments;
    if (params.clientRequestId) payload.clientRequestId = params.clientRequestId;
    
    const res = this.orch.appendEvent({
      conversation: params.conversationId,
      type: 'message',
      payload,
      finality: params.finality,
      agentId: params.agentId,
      ...(params.turnHint !== undefined ? { turn: params.turnHint } : {}),
    });
    
    return { seq: res.seq, turn: res.turn, event: res.event };
  }

  async postTrace(params: { 
    conversationId: number; 
    agentId: string; 
    payload: TracePayload; 
    turn?: number; 
    clientRequestId?: string 
  }) {
    const res = this.orch.appendEvent({
      conversation: params.conversationId,
      type: 'trace',
      payload: params.payload,
      finality: 'none',
      agentId: params.agentId,
      ...(params.turn !== undefined ? { turn: params.turn } : {}),
    });
    
    return { seq: res.seq, turn: res.turn, event: res.event };
  }

  now(): Date {
    return new Date();
  }
}