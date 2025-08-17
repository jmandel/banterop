import type { IAgentClient } from '$src/agents/agent.types';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { MessagePayload, TracePayload } from '$src/types/event.types';

export class InProcessClient implements IAgentClient {
  constructor(private orchestrator: OrchestratorService) {}

  async getSnapshot(conversationId: number) {
    const snap = this.orchestrator.getConversationSnapshot(conversationId, {includeScenario: true});
    if (!snap) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    return snap;
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
    // Calculate the correct turn if not provided
    let turn: number;
    if (params.turn === undefined) {
      const head = (this.orchestrator as any).storage.events.getHead(params.conversationId);
      turn = head.hasOpenTurn ? head.lastTurn : head.lastTurn + 1;
    } else {
      turn = params.turn;
    }

    const res = this.orchestrator.sendMessage(
      params.conversationId,
      turn,
      params.agentId,
      payload,
      params.finality
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
    // Calculate the correct turn if not provided
    let turn: number;
    if (params.turn === undefined) {
      const head = (this.orchestrator as any).storage.events.getHead(params.conversationId);
      // For traces, we must have an open turn
      if (!head.hasOpenTurn) {
        throw new Error(`Cannot send trace without an open turn. Current state: lastTurn=${head.lastTurn}`);
      }
      turn = head.lastTurn;
    } else {
      turn = params.turn;
    }

    const res = this.orchestrator.sendTrace(
      params.conversationId,
      turn,
      params.agentId,
      params.payload
    );
    return { seq: res.seq, turn: res.turn, event: res.event };
  }

  now() {
    return Date.now();
  }
}