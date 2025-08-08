import { BaseAgent, type TurnContext } from '$src/agents/runtime/base-agent';
import type { IAgentTransport, IAgentEvents } from '$src/agents/runtime/runtime.interfaces';
import type { LLMProvider, LLMMessage } from '$src/types/llm.types';
import type { HydratedConversationSnapshot } from '$src/types/orchestrator.types';
import { logLine } from '$src/lib/utils/logger';

export class AssistantAgent extends BaseAgent<HydratedConversationSnapshot> {
  constructor(
    transport: IAgentTransport,
    events: IAgentEvents,
    private llmProvider: LLMProvider
  ) {
    super(transport, events);
  }

  protected async takeTurn(ctx: TurnContext<HydratedConversationSnapshot>): Promise<void> {
    logLine(ctx.agentId, 'info', `AssistantAgent turn started. Using provider: ${this.llmProvider.getMetadata().name}`);

    // Use the snapshot from context (stable view at turn start)
    const snapshot = ctx.snapshot;
    
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
    await ctx.transport.postMessage({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      text: response.content,
      finality: 'turn',
    });

    logLine(ctx.agentId, 'info', 'AssistantAgent turn completed.');
  }
}