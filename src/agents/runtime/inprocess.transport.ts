import type { IAgentTransport, IAgentEvents } from './runtime.interfaces';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { MessagePayload, TracePayload } from '$src/types/event.types';
import type { ConversationSnapshot } from '$src/types/orchestrator.types';
import { InProcessEvents } from './inprocess.events';

export class InProcessTransport implements IAgentTransport {
  constructor(private orchestrator: OrchestratorService) {}

  async getSnapshot(conversationId: number, opts?: { includeScenario?: boolean }): Promise<ConversationSnapshot> {
    return this.orchestrator.getConversationSnapshot(conversationId, opts);
  }

  async clearTurn(conversationId: number, agentId: string): Promise<{ turn: number }> {
    return this.orchestrator.clearTurn(conversationId, agentId);
  }

  async postMessage(params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: NonNullable<MessagePayload['attachments']>;
    clientRequestId?: string;
    turn?: number;
  }): Promise<{ seq: number; turn: number; event: number }> {
    const payload: MessagePayload = {
      text: params.text,
      ...(params.attachments ? { attachments: params.attachments } : {}),
      ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
    };

    return this.orchestrator.sendMessage(
      params.conversationId,
      params.agentId,
      payload,
      params.finality,
      params.turn
    );
  }

  async postTrace(params: {
    conversationId: number;
    agentId: string;
    payload: TracePayload;
    turn?: number;
    clientRequestId?: string;
  }): Promise<{ seq: number; turn: number; event: number }> {
    const payload = {
      ...params.payload,
      ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
    };

    return this.orchestrator.sendTrace(
      params.conversationId,
      params.agentId,
      payload,
      params.turn
    );
  }

  now(): number {
    return Date.now();
  }

  createEventStream(conversationId: number, includeGuidance: boolean): IAgentEvents {
    return new InProcessEvents(this.orchestrator, conversationId, includeGuidance);
  }
}