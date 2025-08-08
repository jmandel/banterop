import type { IAgentClient } from '$src/agents/agent.types';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { MessagePayload, TracePayload } from '$src/types/event.types';

export class InProcessClient implements IAgentClient {
  constructor(private orchestrator: OrchestratorService) {}

  async getSnapshot(conversationId: number) {
    const hydrated = this.orchestrator.getHydratedConversationSnapshot(conversationId);
    if (!hydrated) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    return hydrated;
  }

  async postMessage(params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: NonNullable<MessagePayload['attachments']>;
    clientRequestId?: string;
    turn?: number;
  }) {
    const payload: MessagePayload = {
      text: params.text,
      ...(params.attachments ? { attachments: params.attachments } : {}),
      ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
    };
    const res = this.orchestrator.sendMessage(
      params.conversationId,
      params.agentId,
      payload,
      params.finality,
      params.turn
    );
    return { seq: res.seq, turn: res.turn, event: res.event };
  }

  async postTrace(params: {
    conversationId: number;
    agentId: string;
    payload: TracePayload;
    turn?: number;
    clientRequestId?: string;
  }) {
    const res = this.orchestrator.sendTrace(
      params.conversationId,
      params.agentId,
      params.payload,
      params.turn
    );
    return { seq: res.seq, turn: res.turn, event: res.event };
  }

  now() {
    return Date.now();
  }
}