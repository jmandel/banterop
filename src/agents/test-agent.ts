import type { Agent, AgentContext } from '$src/agents/agent.types';
import type { Finality } from '$src/types/event.types';

/**
 * Test agent that can be configured with specific behaviors
 */
export class TestAgent implements Agent {
  private turnCount = 0;
  
  constructor(
    private config: {
      text?: string;
      finality?: Finality;
      maxTurns?: number;
      stopAfterTurns?: boolean;
    } = {}
  ) {}

  async handleTurn(ctx: AgentContext): Promise<void> {
    this.turnCount++;
    
    const text = this.config.text ?? `Response from ${ctx.agentId} (turn ${this.turnCount})`;
    
    // Determine finality
    let finality: Finality = this.config.finality ?? 'turn';
    
    // If we've reached max turns and should stop, use conversation finality
    if (this.config.maxTurns && this.turnCount >= this.config.maxTurns && this.config.stopAfterTurns) {
      finality = 'conversation';
    }
    
    ctx.logger.info(`TestAgent posting message: ${text} with finality: ${finality}`);
    
    await ctx.client.postMessage({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      text,
      finality,
    });
  }
}