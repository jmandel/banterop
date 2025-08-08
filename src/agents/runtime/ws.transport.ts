import type { IAgentTransport, IAgentEvents } from './runtime.interfaces';
import type { MessagePayload, TracePayload } from '$src/types/event.types';
import type { ConversationSnapshot, HydratedConversationSnapshot } from '$src/types/orchestrator.types';
import { WsEvents } from './ws.events';

/**
 * WebSocket RPC client for agent transport operations
 */
export class WsTransport implements IAgentTransport {
  private ws: WebSocket | undefined;
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
    
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC call ${method} timed out`));
      }, 30000);
      
      this.pending.set(id, (result) => {
        clearTimeout(timeout);
        if (result?.code) {
          reject(new Error(result.message || `RPC error: ${result.code}`));
        } else {
          resolve(result);
        }
      });
      
      this.ws!.send(JSON.stringify({
        id,
        method,
        params,
        jsonrpc: '2.0',
      }));
    });
  }
  
  async getSnapshot(conversationId: number, opts?: { includeScenario?: boolean }): Promise<ConversationSnapshot | HydratedConversationSnapshot> {
    // Use getConversation method which returns a snapshot
    const snapshot = await this.call<any>('getConversation', { 
      conversationId,
      includeScenario: opts?.includeScenario 
    });
    return snapshot;
  }
  
  async postMessage(params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: NonNullable<MessagePayload['attachments']>;
    clientRequestId?: string;
    turn?: number;
    precondition?: { lastClosedSeq: number };
  }): Promise<{ seq: number; turn: number; event: number }> {
    const result = await this.call<any>('sendMessage', {
      conversationId: params.conversationId,
      agentId: params.agentId,
      messagePayload: {
        text: params.text,
        ...(params.attachments ? { attachments: params.attachments } : {}),
        ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
      },
      finality: params.finality,
      ...(params.turn !== undefined ? { turn: params.turn } : {}),
      ...(params.precondition !== undefined ? { precondition: params.precondition } : {}),
    });
    
    // Handle both response formats
    if (result.ok === true) {
      // Simplified response format - need to get the actual values
      return { seq: 0, turn: 0, event: 0 }; // Will be improved when we have proper response
    }
    
    return { 
      seq: result.seq || 0, 
      turn: result.turn || 0, 
      event: result.event || 0 
    };
  }
  
  async postTrace(params: {
    conversationId: number;
    agentId: string;
    payload: TracePayload;
    turn?: number;
    clientRequestId?: string;
    precondition?: { lastClosedSeq: number };
  }): Promise<{ seq: number; turn: number; event: number }> {
    const tracePayload = {
      ...params.payload,
      ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
    };
    
    const result = await this.call<any>('sendTrace', {
      conversationId: params.conversationId,
      agentId: params.agentId,
      tracePayload,
      ...(params.turn !== undefined ? { turn: params.turn } : {}),
      ...(params.precondition !== undefined ? { precondition: params.precondition } : {}),
    });
    
    // Handle both response formats
    if (result.ok === true) {
      return { seq: 0, turn: 0, event: 0 };
    }
    
    return { 
      seq: result.seq || 0, 
      turn: result.turn || 0, 
      event: result.event || 0 
    };
  }
  
  now(): number {
    return Date.now();
  }
  
  createEventStream(conversationId: number, includeGuidance: boolean): IAgentEvents {
    return new WsEvents(this.wsUrl, { conversationId, includeGuidance });
  }
  
  close() {
    if (this.ws) {
      this.ws.close();
    }
    this.ws = undefined;
  }
}