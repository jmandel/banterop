import type { IAgentTransport } from './runtime.interfaces';
import type { MessagePayload, TracePayload } from '$src/types/event.types';
import type { ConversationSnapshot, HydratedConversationSnapshot } from '$src/types/orchestrator.types';
import { mock } from 'bun:test';

export class MockTransport implements IAgentTransport {
  getSnapshot = mock(async (_conversationId: number, _opts?: { includeScenario?: boolean }): Promise<ConversationSnapshot | HydratedConversationSnapshot> => {
    return {
      conversation: _conversationId,
      status: 'active' as const,
      metadata: { agents: [] },
      events: []
    };
  });

  postMessage = mock(async (_params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: NonNullable<MessagePayload['attachments']>;
    clientRequestId?: string;
    turn?: number;
  }): Promise<{ seq: number; turn: number; event: number }> => {
    return { seq: 1, turn: 1, event: 1 };
  });

  postTrace = mock(async (_params: {
    conversationId: number;
    agentId: string;
    payload: TracePayload;
    turn?: number;
    clientRequestId?: string;
  }): Promise<{ seq: number; turn: number; event: number }> => {
    return { seq: 2, turn: 1, event: 2 };
  });

  claimTurn = mock(async (_conversationId: number, _agentId: string, _guidanceSeq: number): Promise<{ ok: boolean; reason?: string }> => {
    return { ok: true };
  });

  now = mock((): number => Date.now());
}