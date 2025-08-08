import { BaseAgent, type TurnContext } from '$src/agents/runtime/base-agent';
import type { IAgentTransport, IAgentEvents } from '$src/agents/runtime/runtime.interfaces';
import { logLine } from '$src/lib/utils/logger';

export class EchoAgent extends BaseAgent {
  constructor(
    transport: IAgentTransport,
    events: IAgentEvents,
    private progressText = 'Processing...', 
    private finalText = 'Done'
  ) {
    super(transport, events);
  }

  protected async takeTurn(ctx: TurnContext): Promise<void> {
    const t0 = Date.now();
    logLine(ctx.agentId, 'turn start', `echo agent`);
    
    const r1 = await ctx.transport.postMessage({ 
      conversationId: ctx.conversationId, 
      agentId: ctx.agentId, 
      text: this.progressText, 
      finality: 'none' 
    });
    logLine(ctx.agentId, 'posted progress', `seq=${r1.seq}`, `${Date.now() - t0}ms`);
    
    const r2 = await ctx.transport.postMessage({ 
      conversationId: ctx.conversationId, 
      agentId: ctx.agentId, 
      text: this.finalText, 
      finality: 'turn' 
    });
    logLine(ctx.agentId, 'posted final', `seq=${r2.seq}`, `${Date.now() - t0}ms`);
  }
}