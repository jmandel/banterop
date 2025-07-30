// Rule Based Agent Implementation

import { 
  RuleBasedConfig, TurnCompletedEvent, 
  TraceEntry
} from '$lib/types.js';
import type { OrchestratorClient } from '$client/index.js';
import { BaseAgent } from '../base.agent.js';

export class RuleBasedAgent extends BaseAgent {
  private config: RuleBasedConfig;

  constructor(config: RuleBasedConfig, client: OrchestratorClient) {
    super(config, client);
    this.config = config;
  }

  async onTurnCompleted(event: TurnCompletedEvent): Promise<void> {
    // Skip if it's our own turn
    if (event.data.turn.agentId === this.agentId.id) {
      return;
    }

    try {
      const context = {
        turn: event.data.turn,
        conversation: await this.getConversation()
      };

      // Evaluate rules
      for (const rule of this.config.rules) {
        console.log('RuleBasedAgent: Evaluating rule:', rule.condition);
        if (this.evaluateCondition(rule.condition, context)) {
          console.log('RuleBasedAgent: Rule matched, starting turn');
          const turnId = await this.startTurn();
          console.log('RuleBasedAgent: Got turn ID:', turnId);
          await this.addThought(turnId, `Rule matched: ${rule.condition}`);
          console.log('RuleBasedAgent: Added thought');
          
          let finalContent = '';
          for (const action of rule.actions) {
            const content = await this.executeAction(action, context, turnId);
            if (content) {
              finalContent = content;
            }
          }
          
          if (finalContent) {
            await this.completeTurn(turnId, finalContent);
          }
          break; // Only execute first matching rule
        } else {
          console.log('RuleBasedAgent: Rule did not match');
        }
      }
    } catch (error) {
      console.error('RuleBasedAgent onTurnCompleted error:', error);
    }
  }

  private evaluateCondition(condition: string, context: any): boolean {
    try {
      // Create a safe evaluation context
      const func = new Function('context', `return ${condition}`);
      return func(context);
    } catch (error) {
      console.error(`Error evaluating condition: ${condition}`, error);
      return false;
    }
  }

  private async executeAction(action: any, context: any, turnId: string): Promise<string | undefined> {
    switch (action.type) {
      case 'respond':
        return action.payload;
      case 'think':
        await this.addThought(turnId, action.payload);
        break;
      case 'call_tool':
        const toolCallId = await this.addToolCall(turnId, action.payload.tool, action.payload.params);
        // Tool execution would go here - for now just add a mock result
        await this.addToolResult(turnId, toolCallId, { status: 'completed' });
        break;
    }
    return undefined;
  }

  private async getConversation(): Promise<any> {
    // Use client to get conversation instead of direct fetch
    return await this.client.getConversation(this.conversationId, {
      includeTurns: true,
      includeTrace: true
    });
  }
}