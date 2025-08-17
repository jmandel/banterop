import { BaseAgent, type TurnContext, type TurnRecoveryMode } from '$src/agents/runtime/base-agent';
import type { IAgentTransport } from '$src/agents/runtime/runtime.interfaces';
import type { LLMProvider, LLMMessage } from '$src/types/llm.types';
import type { ConversationSnapshot } from '$src/types/orchestrator.types';
import { logLine } from '$src/lib/utils/logger';

export class AssistantAgent extends BaseAgent<ConversationSnapshot> {
  constructor(
    transport: IAgentTransport,
    private llmProvider: LLMProvider,
    options?: { turnRecoveryMode?: TurnRecoveryMode }
  ) {
    super(transport, options);
  }

  protected async takeTurn(ctx: TurnContext<ConversationSnapshot>): Promise<void> {
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

    // Check if stopped before LLM call
    if (!this.running) {
      logLine(ctx.agentId, 'warn', 'Agent stopped before LLM call');
      return;
    }
    
    // Log warning if turn number is missing but continue (less critical for AssistantAgent)
    if (ctx.currentTurnNumber === undefined) {
      logLine(ctx.agentId, 'warn', `Missing turn number in context - debugging info: ${JSON.stringify({
        conversationId: ctx.conversationId,
        guidanceSeq: ctx.guidanceSeq,
        hasGuidance: ctx.guidanceSeq > 0,
        deadlineMs: ctx.deadlineMs,
        eventCount: snapshot.events.length,
        lastEventTurn: snapshot.events.length > 0 ? snapshot.events[snapshot.events.length - 1]?.turn : null,
      })}`);
    }
    
    // Call the LLM provider with logging metadata
    const response = await this.llmProvider.complete({ 
      messages,
      loggingMetadata: {
        conversationId: String(ctx.conversationId),
        agentName: ctx.agentId,
        turnNumber: ctx.currentTurnNumber
      }
    });

    // Check if stopped after LLM call
    if (!this.running) {
      logLine(ctx.agentId, 'warn', 'Agent stopped after LLM call');
      return;
    }

    // Post the response back to the conversation
    await ctx.transport.postMessage({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      text: response.content,
      finality: 'turn',
      turn: ctx.currentTurnNumber
    });

    logLine(ctx.agentId, 'info', 'AssistantAgent turn completed.');
  }
}