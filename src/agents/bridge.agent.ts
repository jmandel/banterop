// Bridge Agent - Bridges external clients into conversations
// This agent doesn't know about specific protocols (MCP, etc)
// It just provides a method to bridge external turns into the conversation

import { BaseAgent } from './base.agent.js';
import { ConversationTurn, AttachmentPayload, BridgeToExternalMCPServerConfig, BridgeToExternalMCPClientConfig } from '$lib/types.js';
import type { OrchestratorClient } from '$client/index.js';

export type BridgeAgentConfig = BridgeToExternalMCPServerConfig | BridgeToExternalMCPClientConfig;

export interface BridgeReply {
  reply: string;
  attachments?: Array<{
    name: string;
    contentType: string;
    content: string;
  }>;
}

export class BridgeAgent extends BaseAgent {
  private pendingReplyPromise?: {
    resolve: (reply: BridgeReply) => void;
    reject: (error: Error) => void;
    timeoutId?: NodeJS.Timeout;
    timedOut?: boolean;
  };
  
  constructor(config: BridgeAgentConfig, client: OrchestratorClient) {
    super(config, client);
  }

  /**
   * Bridge an external client's turn into the conversation
   * @param message The message from the external client
   * @param attachments Optional attachments
   * @param timeoutMs Timeout in milliseconds (default 3 minutes)
   * @returns Promise that resolves with the other agent's reply
   */
  async bridgeExternalClientTurn(
    message: string, 
    attachments?: AttachmentPayload[],
    timeoutMs: number = 180000 // 3 minutes default
  ): Promise<BridgeReply> {
    // Start a new turn using the BaseAgent method
    await this.startTurn();
    
    // Add optional trace entry
    await this.addThought('Bridge relay: forwarding message from external client');
    
    // Complete the turn with the external message
    await this.completeTurn(message, false, attachments);
    
    // Use test timeout if available
    const effectiveTimeout = (this as any).__testTimeout || timeoutMs;
    
    // Create promise for the reply
    return new Promise<BridgeReply>((resolve, reject) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (this.pendingReplyPromise) {
          this.pendingReplyPromise.timedOut = true;
          if (this.pendingReplyPromise.timeoutId) {
            clearTimeout(this.pendingReplyPromise.timeoutId);
            this.pendingReplyPromise.timeoutId = undefined;
          }
        }
        reject(new Error('Timeout waiting for reply'));
      }, effectiveTimeout);
      
      // Store promise handlers
      this.pendingReplyPromise = {
        resolve,
        reject,
        timeoutId,
        timedOut: false
      };
    });
  }

  /**
   * Wait for a pending reply if there is one
   * Used when a previous bridgeExternalClientTurn timed out
   */
  async waitForPendingReply(timeoutMs: number = 180000): Promise<BridgeReply> { // 3 minutes default
    if (!this.pendingReplyPromise) {
      throw new Error('No pending reply to wait for');
    }
    
    // Extend the timeout
    if (this.pendingReplyPromise.timeoutId) {
      clearTimeout(this.pendingReplyPromise.timeoutId);
    }
    
    return new Promise<BridgeReply>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingReplyPromise = undefined;
        reject(new Error('Timeout waiting for reply'));
      }, timeoutMs);
      
      // Update the promise with new timeout
      if (this.pendingReplyPromise) {
        this.pendingReplyPromise.timeoutId = timeoutId;
        // Chain the resolution
        const originalResolve = this.pendingReplyPromise.resolve;
        this.pendingReplyPromise.resolve = (reply) => {
          originalResolve(reply);
          resolve(reply);
        };
        const originalReject = this.pendingReplyPromise.reject;
        this.pendingReplyPromise.reject = (error) => {
          originalReject(error);
          reject(error);
        };
      }
    });
  }

  // Override processAndReply to handle incoming turns from other agents
  async processAndReply(previousTurn: ConversationTurn): Promise<void> {
    // If we have a pending reply promise, resolve it
    if (this.pendingReplyPromise && previousTurn.agentId !== this.agentId) {
      const reply: BridgeReply = {
        reply: previousTurn.content
      };
      
      // Add attachments if present
      if (previousTurn.attachments && previousTurn.attachments.length > 0) {
        // Get full attachment data from the client
        const attachments = await Promise.all(
          previousTurn.attachments.map(async (attachmentId) => {
            const attachment = await this.client.getAttachment(attachmentId);
            return {
              name: attachment.name,
              contentType: attachment.contentType,
              content: attachment.content
            };
          })
        );
        reply.attachments = attachments;
      }
      
      // Clear timeout and resolve
      if (this.pendingReplyPromise.timeoutId) {
        clearTimeout(this.pendingReplyPromise.timeoutId);
      }
      this.pendingReplyPromise.resolve(reply);
      this.pendingReplyPromise = undefined;
    }
    
    // Bridge agents don't automatically reply - they wait for external input
  }

  // Bridge agents don't initiate conversations on their own
  async initializeConversation(instructions?: string): Promise<void> {
    console.log(`Bridge agent ${this.agentId} ready to bridge external client`);
    // No automatic initialization - wait for external client
  }
}