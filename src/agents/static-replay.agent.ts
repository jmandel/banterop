// Static Replay Agent Implementation

import { StaticReplayConfig, TurnCompletedEvent, TraceEntry, ConversationTurn } from '$lib/types.js';
import type { OrchestratorClient } from '$client/index.js';
import { BaseAgent } from './base.agent.js';

export class StaticReplayAgent extends BaseAgent {
  declare config: StaticReplayConfig;

  constructor(config: StaticReplayConfig, client: OrchestratorClient) {
    super(config, client);
    this.config = config;
  }

  async initializeConversation(): Promise<void> {
    // Static replay agents can initiate with the first script entry if it has no trigger
    const firstEntry = this.config.script[0];
    if (firstEntry && !firstEntry.trigger) {
      await this.startTurn();
      
      if (firstEntry.thoughts) {
        for (const thought of firstEntry.thoughts) {
          await this.addThought(thought);
        }
      }
      
      if (firstEntry.delay) {
        await new Promise(resolve => setTimeout(resolve, firstEntry.delay));
      }
      
      await this.completeTurn(firstEntry.response);
    }
  }

  async processAndReply(previousTurn: ConversationTurn): Promise<void> {
    // Check if any script entry matches
    for (const entry of this.config.script) {
      // IMPORTANT: If no trigger is specified, don't respond to anything
      // This prevents infinite loops with agents responding to each other
      if (!entry.trigger) {
        continue;
      }

      // Check trigger - only respond if it matches
      const regex = new RegExp(entry.trigger);
      if (!regex.test(previousTurn.content)) {
        continue;
      }

      // Start a new turn
      await this.startTurn();

      // Add thoughts if specified
      if (entry.thoughts) {
        for (const thought of entry.thoughts) {
          await this.addThought(thought);
        }
      }

      // Wait if delay specified
      if (entry.delay) {
        await new Promise(resolve => setTimeout(resolve, entry.delay));
      }

      // Complete the turn with the response
      await this.completeTurn(entry.response);
      break; // Only respond with the first matching entry
    }
  }

  async onTurnCompleted(event: TurnCompletedEvent): Promise<void> {
    // The base agent will call processAndReply, so we don't need to do anything here
    // This prevents duplicate processing
    return;
  }
}