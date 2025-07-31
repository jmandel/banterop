// Static Replay Agent Implementation

import { StaticReplayConfig, TurnCompletedEvent, TraceEntry } from '$lib/types.js';
import type { OrchestratorClient } from '$client/index.js';
import { BaseAgent } from './base.agent.js';

export class StaticReplayAgent extends BaseAgent {
  declare config: StaticReplayConfig;

  constructor(config: StaticReplayConfig, client: OrchestratorClient) {
    super(config, client);
    this.config = config;
  }

  async onTurnCompleted(event: TurnCompletedEvent): Promise<void> {
    // Skip if it's our own turn
    if (event.data.turn.agentId === this.agentId.id) {
      return;
    }

    // Check if any script entry matches (allow any trigger, not sequential)
    for (const entry of this.config.script) {
      // IMPORTANT: If no trigger is specified, don't respond to anything
      // This prevents infinite loops with agents responding to each other
      if (!entry.trigger) {
        continue;
      }

      // Check trigger - only respond if it matches
      const regex = new RegExp(entry.trigger);
      if (!regex.test(event.data.turn.content)) {
        continue;
      }

      // Start a new turn
      const turnId = await this.startTurn();

      // Add thoughts if specified
      if (entry.thoughts) {
        for (const thought of entry.thoughts) {
          await this.addThought(turnId, thought);
        }
      }

      // Wait if delay specified
      if (entry.delay) {
        await new Promise(resolve => setTimeout(resolve, entry.delay));
      }

      // Complete the turn with the response
      await this.completeTurn(turnId, entry.response);
      break; // Only respond once per turn
    }
  }
}