// Location: A new file, e.g., src/lib/utils/conversation-helpers.ts

import type { Conversation } from '$lib/types.js';

/**
 * Extracts the details needed to initiate a conversation from its metadata.
 * This provides a consistent way for any managing party (internal orchestrator or
 * external process) to determine who should start the conversation and with
 * what special instructions.
 *
 * @param conversation The conversation object.
 * @returns An object containing the initiating agent's ID and any runtime instructions.
 */
export function getInitiationDetails(conversation: Conversation): {
  initiatingAgentId?: string;
  instructions?: string;
} {
  return {
    initiatingAgentId: conversation.metadata?.initiatingAgentId,
    instructions: conversation.metadata?.initiatingInstructions
  };
}