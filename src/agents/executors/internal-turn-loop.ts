import type { Agent, AgentContext, Logger } from '$src/agents/agent.types';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { GuidanceEvent } from '$src/types/orchestrator.types';
import type { UnifiedEvent } from '$src/types/event.types';
import { InProcessEventStream, type StreamEvent } from '$src/agents/clients/event-stream';
import { InProcessClient } from '$src/agents/clients/inprocess.client';
import { logLine, colors } from '$src/lib/utils/logger';

export interface InternalLoopOptions {
  conversationId: number;
  agentId: string;
  logger?: Logger;
}

/**
 * Internal executor using the same guidance/claim pattern as external
 * Replaces the complex worker-runner.ts and policy callbacks
 */
export class InternalTurnLoop {
  private stream: InProcessEventStream | undefined;
  private stopped = false;
  
  constructor(
    private agent: Agent,
    private orchestrator: OrchestratorService,
    private options: InternalLoopOptions
  ) {}
  
  async start(): Promise<void> {
    const { conversationId, agentId } = this.options;
    const logger = this.options.logger ?? this.createDefaultLogger();
    
    logLine(agentId, colors.green('START INTERNAL'), `conv=${conversationId}`);
    
    // Create in-process event stream with guidance enabled
    this.stream = new InProcessEventStream(this.orchestrator, {
      conversationId,
      includeGuidance: true,
    });
    
    try {
      // Main event loop - identical to external!
      for await (const event of this.stream) {
        if (this.stopped) break;
        
        // Check if this is a guidance event for us
        if (this.isGuidanceForMe(event)) {
          const guidance = event as GuidanceEvent;
          logLine(agentId, colors.cyan('GUIDANCE'), `seq=${guidance.seq}`);
          
          // Try to claim the turn
          const claimed = await this.orchestrator.claimTurn(conversationId, agentId, guidance.seq);
          
          if (claimed.ok) {
            logLine(agentId, colors.green('CLAIMED'), `guidanceSeq=${guidance.seq}`);
            
            // Create agent context with in-process client
            const ctx: AgentContext = {
              conversationId,
              agentId,
              deadlineMs: Date.now() + (guidance.deadlineMs || 30000),
              client: new InProcessClient(this.orchestrator),
              logger,
            };
            
            // Run agent for one turn
            try {
              await this.agent.handleTurn(ctx);
              logLine(agentId, colors.bright('TURN COMPLETE'));
            } catch (err) {
              logLine(agentId, colors.red('TURN ERROR'), String(err));
            }
          } else {
            logLine(agentId, colors.yellow('CLAIM FAILED'), claimed.reason || 'unknown');
          }
        }
        
        // Check for conversation end
        if (this.isConversationEnd(event)) {
          logLine(agentId, colors.yellow('CONVERSATION END'));
          break;
        }
      }
    } finally {
      this.stop();
    }
    
    logLine(agentId, colors.green('STOPPED INTERNAL'));
  }
  
  stop(): void {
    this.stopped = true;
    if (this.stream) {
      this.stream.close();
      this.stream = undefined;
    }
  }
  
  private isGuidanceForMe(event: StreamEvent): boolean {
    if (!('type' in event)) return false;
    if (event.type !== 'guidance') return false;
    const guidance = event as GuidanceEvent;
    // Match only if guidance is explicitly for us
    return guidance.nextAgentId === this.options.agentId;
  }
  
  private isConversationEnd(event: StreamEvent): boolean {
    if (!('type' in event)) return false;
    if (event.type !== 'message') return false;
    const msg = event as UnifiedEvent;
    return msg.finality === 'conversation';
  }
  
  private createDefaultLogger(): Logger {
    const agentId = this.options.agentId;
    return {
      debug: (msg: string) => logLine(agentId, 'debug', msg),
      info: (msg: string) => logLine(agentId, 'info', msg),
      warn: (msg: string) => logLine(agentId, colors.yellow('warn'), msg),
      error: (msg: string) => logLine(agentId, colors.red('error'), msg),
    };
  }
}