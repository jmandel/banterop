// External Proxy Agent Implementation

import { 
  ExternalProxyConfig, TurnAddedEvent, TurnCompletedEvent
} from '$lib/types.js';
import type { OrchestratorClient } from '$client/index.js';
import { BaseAgent } from '../base.agent.js';

export class ExternalProxyAgent extends BaseAgent {
  private config: ExternalProxyConfig;

  constructor(config: ExternalProxyConfig, client: OrchestratorClient) {
    super(config, client);
    this.config = config;
  }

  async onTurnAdded(event: TurnAddedEvent | TurnCompletedEvent): Promise<void> {
    // Skip if it's our own turn
    if (event.data.turn.agentId === this.agentId.id) {
      return;
    }

    try {
      // Forward to external service
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers
        },
        body: JSON.stringify({
          event,
          agentId: this.agentId,
          conversationId: this.conversationId
        }),
        signal: AbortSignal.timeout(this.config.timeout || 30000)
      });

      if (!response.ok) {
        throw new Error(`External service error: ${response.status}`);
      }

      const result = await response.json();
      
      // Use streaming approach with external service response
      const turnId = await this.startTurn();
      
      // Add any trace entries from external service
      if (result.trace) {
        for (const entry of result.trace) {
          switch (entry.type) {
            case 'thought':
              await this.addThought(turnId, entry.content);
              break;
            case 'tool_call':
              await this.addToolCall(turnId, entry.toolName, entry.parameters);
              break;
            // Add other trace types as needed
          }
        }
      }
      
      await this.completeTurn(turnId, result.content);
    } catch (error: any) {
      console.error(`External proxy error: ${error.message}`);
      // Fallback response using streaming approach
      const turnId = await this.startTurn();
      await this.addThought(turnId, `Error contacting external service: ${error.message}`);
      await this.completeTurn(turnId, `[${this.agentId.label}] External service unavailable: ${error.message}`);
    }
  }
}