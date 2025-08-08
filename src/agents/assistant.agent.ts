import type { Agent, AgentContext } from './agent.types';
import type { LLMProvider, LLMMessage } from '$src/types/llm.types';

export class AssistantAgent implements Agent {
  constructor(private llmProvider: LLMProvider) {}

  async handleTurn(ctx: AgentContext): Promise<void> {
    ctx.logger.info(`AssistantAgent turn started. Using provider: ${this.llmProvider.getMetadata().name}`);

    // Get conversation history from the snapshot
    const snapshot = await ctx.client.getSnapshot(ctx.conversationId);
    
    // Build messages array - following v2 pattern
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' }
    ];
    
    // Add conversation history
    for (const event of snapshot.events) {
      if (event.type === 'message') {
        messages.push({
          role: event.agentId === ctx.agentId ? 'assistant' : 'user',
          content: (event.payload as any).text,
        });
      }
    }

    // Call the LLM provider
    const response = await this.llmProvider.complete({ messages });

    // Post the response back to the conversation
    await ctx.client.postMessage({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      text: response.content,
      finality: 'turn',
    });

    ctx.logger.info('AssistantAgent turn completed.');
  }
}