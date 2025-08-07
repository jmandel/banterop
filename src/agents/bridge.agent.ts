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
  private pendingReplyPromise?: Promise<BridgeReply>;
  private pendingReplyResolvers?: {
    resolve: (reply: BridgeReply) => void;
    reject: (error: Error) => void;
    timeoutId?: NodeJS.Timeout;
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
    // timeoutMs: number = 180000 // 3 minutes default
    timeoutMs: number = 5 * 1000 // .5min for testing
  ): Promise<BridgeReply> {
    // Generate unique request ID for correlation
    const requestId = `bridge_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    
    console.log(`[${timestamp}] [BridgeAgent ${this.agentId}] bridgeExternalClientTurn START - requestId=${requestId}, conversationId=${this.conversationId}, timeoutMs=${timeoutMs}`);
    
    // Start a new turn using the BaseAgent method
    await this.startTurn();
    
    // Add optional trace entry
    await this.addThought('Bridge relay: forwarding message from external client');
    
    // Complete the turn with the external message
    await this.completeTurn(message, false, attachments);
    
    // Use test timeout if available
    const effectiveTimeout = (this as any).__testTimeout || timeoutMs;
    
    console.log(`[${new Date().toISOString()}] [BridgeAgent ${this.agentId}] Setting timeout for ${effectiveTimeout}ms - requestId=${requestId}`);
    
    // Create promise for the reply if not already waiting
    if (!this.pendingReplyPromise) {
      this.pendingReplyPromise = new Promise<BridgeReply>((resolve, reject) => {
        // Set up timeout
        const timeoutId = setTimeout(() => {
          const elapsed = Date.now() - startTime;
          const timeoutTimestamp = new Date().toISOString();
          console.log(`[${timeoutTimestamp}] [BridgeAgent ${this.agentId}] TIMEOUT FIRED - requestId=${requestId}, elapsed=${elapsed}ms, pendingResolvers=${!!this.pendingReplyResolvers}`);
          
          this.pendingReplyResolvers = undefined;
          this.pendingReplyPromise = undefined;
          reject(new Error(`Timeout waiting for reply after ${elapsed}ms`));
        }, effectiveTimeout);
        
        // Store resolvers with request metadata
        this.pendingReplyResolvers = {
          resolve: (reply: BridgeReply) => {
            const elapsed = Date.now() - startTime;
            console.log(`[${new Date().toISOString()}] [BridgeAgent ${this.agentId}] Reply resolved - requestId=${requestId}, elapsed=${elapsed}ms`);
            resolve(reply);
          },
          reject: (error: Error) => {
            const elapsed = Date.now() - startTime;
            console.log(`[${new Date().toISOString()}] [BridgeAgent ${this.agentId}] Reply rejected - requestId=${requestId}, elapsed=${elapsed}ms, error=${error.message}`);
            reject(error);
          },
          timeoutId,
          requestId // Store for correlation
        } as any;
      });
    } else {
      console.log(`[${new Date().toISOString()}] [BridgeAgent ${this.agentId}] Reusing existing pendingReplyPromise - requestId=${requestId}`);
    }
    
    return this.pendingReplyPromise;
  }

  /**
   * Wait for a pending reply if there is one
   * Used when a previous bridgeExternalClientTurn timed out or to check for already-available replies
   */
  async waitForPendingReply(timeoutMs: number = 5 * 1000): Promise<BridgeReply> { // 3 minutes default
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [BridgeAgent ${this.agentId}] waitForPendingReply called - conversationId=${this.conversationId}`);
    
    // First check if a reply is already available (most recent turn from another agent)
    const lastTurn = this.getLastTurn();
    if (lastTurn && lastTurn.agentId !== this.agentId && lastTurn.status === 'completed') {
      console.log(`[${new Date().toISOString()}] [BridgeAgent ${this.agentId}] Reply already in history - returning immediately, turnId=${lastTurn.id}`);
      // We have a completed turn from another agent - return it immediately
      const reply: BridgeReply = {
        reply: lastTurn.content
      };
      
      // Add attachments if present
      if (lastTurn.attachments && lastTurn.attachments.length > 0) {
        const attachments = await Promise.all(
          lastTurn.attachments.map(async (attachmentId) => {
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
      
      // Clear any pending promise since we found the reply
      if (this.pendingReplyResolvers) {
        if (this.pendingReplyResolvers.timeoutId) {
          clearTimeout(this.pendingReplyResolvers.timeoutId);
        }
        // Resolve the existing promise for any other waiters
        this.pendingReplyResolvers.resolve(reply);
        this.pendingReplyResolvers = undefined;
        this.pendingReplyPromise = undefined;
      }
      
      return reply;
    }
    
    // No reply available yet, return existing promise or create new one
    if (this.pendingReplyPromise) {
      // Already waiting, return the same promise
      return this.pendingReplyPromise;
    }
    
    // Create a new promise for all waiters to share
    this.pendingReplyPromise = new Promise<BridgeReply>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingReplyResolvers = undefined;
        this.pendingReplyPromise = undefined;
        reject(new Error('Timeout waiting for reply'));
      }, timeoutMs);
      
      this.pendingReplyResolvers = {
        resolve,
        reject,
        timeoutId
      };
    });
    
    return this.pendingReplyPromise;
  }

  // Override processAndReply to handle incoming turns from other agents
  async processAndReply(previousTurn: ConversationTurn): Promise<void> {
    const timestamp = new Date().toISOString();
    const requestId = (this.pendingReplyResolvers as any)?.requestId || 'unknown';
    console.log(`[${timestamp}] [BridgeAgent ${this.agentId}] processAndReply - turnId=${previousTurn.id}, fromAgent=${previousTurn.agentId}, hasPendingResolvers=${!!this.pendingReplyResolvers}, requestId=${requestId}`);
    
    // If we have a pending reply promise, resolve it
    if (this.pendingReplyResolvers && previousTurn.agentId !== this.agentId) {
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
      if (this.pendingReplyResolvers.timeoutId) {
        clearTimeout(this.pendingReplyResolvers.timeoutId);
      }
      console.log(`[${new Date().toISOString()}] [BridgeAgent ${this.agentId}] Resolving pending reply - requestId=${requestId}`);
      this.pendingReplyResolvers.resolve(reply);
      this.pendingReplyResolvers = undefined;
      this.pendingReplyPromise = undefined;
    } else if (previousTurn.agentId !== this.agentId) {
      // Reply arrived but no one is waiting (late reply scenario)
      console.log(`[${new Date().toISOString()}] [BridgeAgent ${this.agentId}] LATE REPLY - no pending resolvers, turnId=${previousTurn.id}`);
    }
    
    // Bridge agents don't automatically reply - they wait for external input
  }

  // Bridge agents don't initiate conversations on their own
  async initializeConversation(instructions?: string): Promise<void> {
    console.log(`Bridge agent ${this.agentId} ready to bridge external client`);
    // No automatic initialization - wait for external client
  }
}