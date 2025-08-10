import type { ConversationMeta } from '$src/types/conversation.meta';
import type { ConversationSnapshot } from '$src/types/orchestrator.types';

export interface OrchestratorControl {
  createConversation(meta: ConversationMeta): Promise<number>;
  getConversation(conversationId: number, opts?: { includeScenario?: boolean }): Promise<ConversationSnapshot>;

  ensureAgentsRunning(conversationId: number, agentIds?: string[]): Promise<{ ensured: Array<{ id: string; class?: string }> }>;
  stopAgents(conversationId: number): Promise<void>;
}

