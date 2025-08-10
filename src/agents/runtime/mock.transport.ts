import type { IAgentTransport, IAgentEvents } from './runtime.interfaces';
import type { MessagePayload, TracePayload } from '$src/types/event.types';
import type { ConversationSnapshot } from '$src/types/orchestrator.types';
import { mock } from 'bun:test';

export class MockTransport implements IAgentTransport {
  getSnapshot = mock(async (_conversationId: number, _opts?: { includeScenario?: boolean }): Promise<ConversationSnapshot> => {
    return {
      conversation: _conversationId,
      status: 'active' as const,
      metadata: { agents: [] },
      events: [],
      lastClosedSeq: 0
    };
  });

  clearTurn = mock(async (_conversationId: number, _agentId: string): Promise<{ turn: number }> => {
    return { turn: 1 };
  });

  postMessage = mock(async (_params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: NonNullable<MessagePayload['attachments']>;
    clientRequestId?: string;
    turn?: number;
  }): Promise<{ conversation: number; seq: number; turn: number; event: number }> => {
    return { conversation: _params.conversationId, seq: 1, turn: 1, event: 1 };
  });

  postTrace = mock(async (_params: {
    conversationId: number;
    agentId: string;
    payload: TracePayload;
    turn?: number;
    clientRequestId?: string;
  }): Promise<{ conversation: number; seq: number; turn: number; event: number }> => {
    return { conversation: _params.conversationId, seq: 2, turn: 1, event: 2 };
  });

  now = mock((): number => Date.now());

  createEventStream = mock((_conversationId: number, _includeGuidance: boolean): IAgentEvents => {
    return {
      subscribe: () => () => {} // Returns unsubscribe function
    };
  });
}
