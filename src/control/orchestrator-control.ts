import type { ConversationMeta } from '$src/types/conversation.meta';
import type { ConversationSnapshot } from '$src/types/orchestrator.types';

export interface OrchestratorControl {
  createConversation(meta: ConversationMeta): Promise<number>;
  getConversation(conversationId: number, opts?: { includeScenario?: boolean }): Promise<ConversationSnapshot>;

  getEnsuredAgentsOnServer(conversationId: number): Promise<{ ensured: Array<{ id: string; class?: string }> }>;
  ensureAgentsRunningOnServer(conversationId: number, agentIds?: string[]): Promise<{ ensured: Array<{ id: string; class?: string }> }>;
  stopAgentsOnServer(conversationId: number, agentIds?: string[]): Promise<void>;
}
