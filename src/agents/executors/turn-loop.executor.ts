import type { Agent, AgentContext, Logger } from '$src/agents/agent.types';
import type { GuidanceEvent } from '$src/types/orchestrator.types';
import type { UnifiedEvent, TracePayload } from '$src/types/event.types';
import { WsEventStream, type StreamEvent } from '$src/agents/clients/event-stream';
import { logLine, colors } from '$src/lib/utils/logger';

export interface TurnLoopOptions {
  conversationId: number;
  agentId: string;
  wsUrl: string;
  logger?: Logger;
}

/**
 * Simplified external executor using guidance events and turn claims
 * Replaces 600+ LOC external.executor.ts with < 100 LOC
 */
export class TurnLoopExecutor {
  private stream: WsEventStream | undefined;
  private stopped = false;
  
  constructor(
    private agent: Agent,
    private options: TurnLoopOptions
  ) {}
  
  async start(): Promise<void> {
    const { conversationId, agentId, wsUrl } = this.options;
    const logger = this.options.logger ?? this.createDefaultLogger();
    
    logLine(agentId, colors.green('START'), `conv=${conversationId}`);
    
    // Create event stream with guidance enabled
    this.stream = new WsEventStream(wsUrl, {
      conversationId,
      includeGuidance: true,
      reconnectDelayMs: 1000,
      heartbeatIntervalMs: 15000,
    });
    
    // Create claim client for making RPC calls
    const claimClient = new ClaimClient(wsUrl);
    
    try {
      // Main event loop
      for await (const event of this.stream) {
        if (this.stopped) break;
        
        // Check if this is a guidance event for us
        if (this.isGuidanceForMe(event)) {
          const guidance = event as GuidanceEvent;
          logLine(agentId, colors.cyan('GUIDANCE'), `seq=${guidance.seq} deadline=${guidance.deadlineMs}ms`);
          
          // Try to claim the turn
          const claimed = await claimClient.claimTurn(conversationId, agentId, guidance.seq);
          
          if (claimed.ok) {
            logLine(agentId, colors.green('CLAIMED'), `guidanceSeq=${guidance.seq}`);
            
            // Create agent context
            const ctx: AgentContext = {
              conversationId,
              agentId,
              deadlineMs: Date.now() + (guidance.deadlineMs || 30000),
              client: claimClient,
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
      await this.stop();
    }
    
    logLine(agentId, colors.green('STOPPED'));
  }
  
  async stop(): Promise<void> {
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

/**
 * Simple WebSocket RPC client for claim_turn and basic operations
 */
class ClaimClient {
  private ws?: WebSocket;
  private pending = new Map<string, (result: any) => void>();
  
  constructor(private wsUrl: string) {}
  
  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      
      this.ws.onopen = () => resolve();
      this.ws.onerror = reject;
      
      this.ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string);
          const resolver = this.pending.get(msg.id);
          if (resolver) {
            this.pending.delete(msg.id);
            resolver(msg.result || msg.error);
          }
        } catch {}
      };
    });
  }
  
  private async call<T>(method: string, params: any): Promise<T> {
    await this.ensureConnected();
    
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      this.pending.set(id, resolve);
      
      this.ws!.send(JSON.stringify({
        id,
        method,
        params,
        jsonrpc: '2.0',
      }));
    });
  }
  
  async claimTurn(conversationId: number, agentId: string, guidanceSeq: number): Promise<{ ok: boolean; reason?: string }> {
    return this.call('claimTurn', { conversationId, agentId, guidanceSeq });
  }
  
  async postMessage(params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: Array<{
      id?: string;
      docId?: string;
      name: string;
      contentType: string;
      content?: string;
      summary?: string;
    }>;
    clientRequestId?: string;
    turn?: number; // unified
  }): Promise<{ seq: number; turn: number; event: number }> {
    const result = await this.call<{ conversation: number; turn: number; event: number; seq: number }>(
      'sendMessage',
      {
        conversationId: params.conversationId,
        agentId: params.agentId,
        messagePayload: {
          text: params.text,
          attachments: params.attachments,
          ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
        },
        finality: params.finality,
        turn: params.turn, // unified
      }
    );
    return { seq: result.seq || 0, turn: result.turn || 0, event: result.event || 0 };
  }
  
  async getSnapshot(conversationId: number): Promise<any> {
    return this.call('getConversation', { conversationId });
  }

  async postTrace(params: {
    conversationId: number;
    agentId: string;
    payload: any;
    turn?: number;
    clientRequestId?: string;
  }): Promise<{ seq: number; turn: number; event: number }> {
    const result = await this.call<{ conversation: number; turn: number; event: number; seq: number }>(
      'sendTrace',
      {
        conversationId: params.conversationId,
        agentId: params.agentId,
        tracePayload: params.payload,
        turn: params.turn, // unified
      }
    );
    return { seq: result.seq || 0, turn: result.turn || 0, event: result.event || 0 };
  }
  
  now() {
    return Date.now();
  }
}