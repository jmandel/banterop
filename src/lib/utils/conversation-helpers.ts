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
  // Find the agent that should initiate the conversation
  const initiatingAgent = conversation.agents.find(agent => agent.shouldInitiateConversation);
  
  if (initiatingAgent) {
    return {
      initiatingAgentId: initiatingAgent.id,
      instructions: initiatingAgent.additionalInstructions
    };
  }
  
  return {
    initiatingAgentId: undefined,
    instructions: undefined
  };
}