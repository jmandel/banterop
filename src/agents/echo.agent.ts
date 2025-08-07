import type { Agent, AgentContext } from '$src/agents/agent.types';
import { logLine } from '$src/lib/utils/logger';

export class EchoAgent implements Agent {
  constructor(
    private progressText = 'Processing...', 
    private finalText = 'Done'
  ) {}

  async handleTurn(ctx: AgentContext): Promise<void> {
    const t0 = Date.now();
    logLine(ctx.agentId, 'turn start', `echo agent`);
    
    const r1 = await ctx.client.postMessage({ 
      conversationId: ctx.conversationId, 
      agentId: ctx.agentId, 
      text: this.progressText, 
      finality: 'none' 
    });
    logLine(ctx.agentId, 'posted progress', `seq=${r1.seq}`, `${Date.now() - t0}ms`);
    
    const r2 = await ctx.client.postMessage({ 
      conversationId: ctx.conversationId, 
      agentId: ctx.agentId, 
      text: this.finalText, 
      finality: 'turn' 
    });
    logLine(ctx.agentId, 'posted final', `seq=${r2.seq}`, `${Date.now() - t0}ms`);
  }
}