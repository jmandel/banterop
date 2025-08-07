import type { Agent, AgentContext, Logger } from '$src/agents/agent.types';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { GuidanceEvent } from '$src/types/orchestrator.types';
import type { UnifiedEvent, MessagePayload } from '$src/types/event.types';
import { InProcessEventStream, type StreamEvent } from '$src/agents/clients/event-stream';
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
              client: new InProcessClient(this.orchestrator, conversationId, agentId),
              logger,
            };
            
            // Run agent for one turn
            try {
              const outcome = await this.agent.handleTurn(ctx);
              logLine(agentId, colors.bright('TURN COMPLETE'), `outcome=${outcome}`);
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
    // Match if guidance is explicitly for us
    if (guidance.nextAgentId === this.options.agentId) return true;
    // Also match if guidance is for 'assistant' and we're agent-a (first responder)
    if (guidance.nextAgentId === 'assistant' && this.options.agentId === 'agent-a') return true;
    return false;
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

/**
 * Minimal in-process client for internal agents
 * No more getUpdatesOrGuidance or waitForChange!
 */
class InProcessClient {
  constructor(
    private orchestrator: OrchestratorService,
    _conversationId: number,
    _agentId: string
  ) {}
  
  async postMessage(params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: any[];
  }): Promise<{ seq: number; turn: number; event: number }> {
    const payload: MessagePayload = { text: params.text };
    if (params.attachments) payload.attachments = params.attachments;
    
    const result = this.orchestrator.appendEvent({
      conversation: params.conversationId,
      type: 'message',
      payload,
      finality: params.finality,
      agentId: params.agentId,
    });
    
    return {
      seq: result.seq,
      turn: result.turn,
      event: result.event,
    };
  }
  
  async postTrace(params: {
    conversationId: number;
    agentId: string;
    payload: any;
    turn?: number;
  }): Promise<{ seq: number; turn: number; event: number }> {
    const result = this.orchestrator.appendEvent({
      conversation: params.conversationId,
      type: 'trace',
      payload: params.payload,
      finality: 'none',
      agentId: params.agentId,
      ...(params.turn !== undefined ? { turn: params.turn } : {}),
    });
    
    return {
      seq: result.seq,
      turn: result.turn,
      event: result.event,
    };
  }
  
  async getSnapshot(conversationId: number): Promise<any> {
    return this.orchestrator.getConversationSnapshot(conversationId);
  }
  
  now(): Date {
    return new Date();
  }
}