import { BaseAgent } from './base.agent.js';
import { ConversationTurn, RehydratedEvent } from '../types/index.js';

/**
 * SimpleResumableAgent - A minimal agent designed to demonstrate resurrection capability
 * 
 * This agent:
 * - Sends exactly 3 messages total
 * - Derives its state from conversation history (stateless)
 * - Has no race conditions
 * - Can be interrupted and resumed at any point
 */
export class SimpleResumableAgent extends BaseAgent {
  private messageCount = 0;
  private readonly maxMessages = 5; // Increased to allow interruption mid-conversation
  
  async initializeConversation(instructions?: string): Promise<void> {
    // First check if we've already sent messages
    const turns = this.getTurns();
    const myTurns = turns.filter(t => t.agentId === this.agentId && t.status === 'completed');
    this.messageCount = myTurns.length;
    
    console.log(`${this.agentId}: Initializing, have already sent ${this.messageCount} messages`);
    
    // Don't send a message if we've already sent any messages or reached the max
    if (this.messageCount > 0 || this.messageCount >= this.maxMessages) {
      console.log(`${this.agentId}: Already sent ${this.messageCount} messages, not initializing`);
      return;
    }
    
    await this.startTurn();
    await this.addThought('Starting conversation');
    await this.completeTurn(`Message 1 of 5`);
    // Don't set messageCount here - let it be derived from history
  }
  
  async processAndReply(previousTurn: ConversationTurn): Promise<void> {
    // Derive message count from conversation history
    const turns = this.getTurns();
    const myTurns = turns.filter(t => t.agentId === this.agentId && t.status === 'completed');
    this.messageCount = myTurns.length;
    
    console.log(`${this.agentId}: Processing turn from ${previousTurn.agentId}, total turns: ${turns.length}, my completed turns: ${myTurns.length}`);
    console.log(`${this.agentId}: Turn IDs: ${turns.map(t => `${t.agentId}:${t.id.substring(0,8)}`).join(', ')}`);
    
    if (this.messageCount >= this.maxMessages) {
      console.log(`${this.agentId}: Already sent max messages (${this.maxMessages}), not responding`);
      return;
    }
    
    
    // Calculate next message number based on current count
    const nextMessageNum = this.messageCount + 1;
    
    await this.startTurn();
    await this.addThought(`Preparing message ${nextMessageNum}`);
    await this.completeTurn(`Message ${nextMessageNum} of 5`);
    // Don't increment here - let the next call derive from history
  }
  
  async onRehydrated(event: RehydratedEvent): Promise<void> {
    // Reconstruct state from history
    const turns = this.getTurns();
    const myTurns = turns.filter(t => t.agentId === this.agentId && t.status === 'completed');
    this.messageCount = myTurns.length;
    
    console.log(`${this.agentId}: Rehydrated with ${this.messageCount} messages sent`);
    
    // Check if there's an in-progress turn that was interrupted
    const inProgressTurns = event.inProgressTurns || [];
    const myInProgressTurn = inProgressTurns.find(t => t.agentId === this.agentId);
    
    if (myInProgressTurn) {
      console.log(`${this.agentId}: Found in-progress turn ${myInProgressTurn.id}, will be handled by orchestrator`);
    }
    
    // Check if we should continue the conversation
    if (this.messageCount < this.maxMessages) {
      // Check if it's our turn to respond
      const lastTurn = turns[turns.length - 1];
      if (lastTurn && lastTurn.agentId !== this.agentId) {
        console.log(`${this.agentId}: Last turn was from ${lastTurn.agentId}, considering response`);
        // Don't immediately respond - let the orchestrator handle turn management
        // The orchestrator will call processAndReply if appropriate
      }
    }
    
    return super.onRehydrated(event);
  }
  
  /**
   * Helper method for testing - get current message count
   */
  getMessageCount(): number {
    return this.messageCount;
  }
}