import type { IAgentTransport } from './runtime.interfaces';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { MessagePayload, TracePayload } from '$src/types/event.types';
import type { ConversationSnapshot, HydratedConversationSnapshot } from '$src/types/orchestrator.types';

export class InProcessTransport implements IAgentTransport {
  constructor(private orchestrator: OrchestratorService) {}

  async getSnapshot(conversationId: number, opts?: { includeScenario?: boolean }): Promise<ConversationSnapshot | HydratedConversationSnapshot> {
    if (opts?.includeScenario) {
      const hydrated = this.orchestrator.getHydratedConversationSnapshot(conversationId);
      if (!hydrated) {
        throw new Error(`Conversation ${conversationId} not found`);
      }
      return hydrated;
    }
    return this.orchestrator.getConversationSnapshot(conversationId);
  }

  async postMessage(params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: NonNullable<MessagePayload['attachments']>;
    clientRequestId?: string;
    turn?: number;
    precondition?: { lastClosedSeq: number };
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
      params.turn,
      params.precondition
    );
  }

  async postTrace(params: {
    conversationId: number;
    agentId: string;
    payload: TracePayload;
    turn?: number;
    clientRequestId?: string;
    precondition?: { lastClosedSeq: number };
  }): Promise<{ seq: number; turn: number; event: number }> {
    const payload = {
      ...params.payload,
      ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
    };

    return this.orchestrator.sendTrace(
      params.conversationId,
      params.agentId,
      payload,
      params.turn,
      params.precondition
    );
  }

  now(): number {
    return Date.now();
  }
}