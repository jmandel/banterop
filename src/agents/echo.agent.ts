import { BaseAgent, type TurnContext, type TurnRecoveryMode } from '$src/agents/runtime/base-agent';
import type { IAgentTransport } from '$src/agents/runtime/runtime.interfaces';
import { logLine } from '$src/lib/utils/logger';

export class EchoAgent extends BaseAgent {
  private progressText: string;
  private finalText: string;
  
  constructor(
    transport: IAgentTransport,
    progressText = 'Processing...', 
    finalText = 'Done',
    options?: { turnRecoveryMode?: TurnRecoveryMode }
  ) {
    super(transport, options);
    this.progressText = progressText;
    this.finalText = finalText;
  }

  protected async takeTurn(ctx: TurnContext): Promise<void> {
    const t0 = Date.now();
    logLine(ctx.agentId, 'turn start', `echo agent`);
    
    // No precondition needed - orchestrator handles turn continuity
    const r1 = await ctx.transport.postMessage({ 
      conversationId: ctx.conversationId, 
      agentId: ctx.agentId, 
      text: this.progressText, 
      finality: 'none',
      turn: ctx.currentTurnNumber
    });
    logLine(ctx.agentId, 'posted progress', `seq=${r1.seq}`, `${Date.now() - t0}ms`);
    
    // Second message continues same turn automatically
    const r2 = await ctx.transport.postMessage({ 
      conversationId: ctx.conversationId, 
      agentId: ctx.agentId, 
      text: this.finalText, 
      finality: 'turn',
      turn: ctx.currentTurnNumber
    });
    logLine(ctx.agentId, 'posted final', `seq=${r2.seq}`, `${Date.now() - t0}ms`);
  }
}