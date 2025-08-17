import type { IAgentTransport, IAgentEvents } from './runtime.interfaces';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { MessagePayload, TracePayload, AttachmentRow } from '$src/types/event.types';
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
  }): Promise<{ conversation: number; seq: number; turn: number; event: number }> {
    const payload: MessagePayload = {
      text: params.text,
      ...(params.attachments ? { attachments: params.attachments } : {}),
      ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
    };

    // Calculate turn when not provided - transport layer adapts for agents that don't track turns
    let turn: number;
    if (params.turn === undefined) {
      const head = (this.orchestrator as any).storage.events.getHead(params.conversationId);
      turn = head.hasOpenTurn ? head.lastTurn : head.lastTurn + 1;
    } else {
      turn = params.turn;
    }

    return this.orchestrator.sendMessage(
      params.conversationId,
      turn,
      params.agentId,
      payload,
      params.finality
    );
  }

  async postTrace(params: {
    conversationId: number;
    agentId: string;
    payload: TracePayload;
    turn: number;  // REQUIRED
    clientRequestId?: string;
  }): Promise<{ conversation: number; seq: number; turn: number; event: number }> {
    const payload = {
      ...params.payload,
      ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
    };

    return this.orchestrator.sendTrace(
      params.conversationId,
      params.turn,
      params.agentId,
      payload
    );
  }

  now(): number {
    return Date.now();
  }

  createEventStream(conversationId: number, includeGuidance: boolean): IAgentEvents {
    return new InProcessEvents(this.orchestrator, conversationId, includeGuidance);
  }

   async getAttachmentByDocId(params: { conversationId: number; docId: string }): Promise<AttachmentRow | null> {
     return this.orchestrator.getAttachmentByDocId(params.conversationId, params.docId);
   }
}
