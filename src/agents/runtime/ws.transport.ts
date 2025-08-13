import type { IAgentTransport, IAgentEvents } from './runtime.interfaces';
import type { MessagePayload, TracePayload, AttachmentRow } from '$src/types/event.types';
import type { ConversationSnapshot } from '$src/types/orchestrator.types';
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
  
  async getSnapshot(conversationId: number, opts?: { includeScenario?: boolean }): Promise<ConversationSnapshot> {
    // Use getConversation method which returns a snapshot with scenario if requested
    const snapshot = await this.call<any>('getConversation', { 
      conversationId,
      includeScenario: opts?.includeScenario ?? true
    });
    return snapshot;
  }
  
  async clearTurn(conversationId: number, agentId: string): Promise<{ turn: number }> {
    return await this.call<{ turn: number }>('clearTurn', {
      conversationId,
      agentId
    });
  }
  
  async postMessage(params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: NonNullable<MessagePayload['attachments']>;
    clientRequestId?: string;
    turn?: number;
  }): Promise<{ conversation: number; seq: number; turn: number; event: number }> {
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
    });
    return {
      conversation: result.conversation,
      seq: result.seq,
      turn: result.turn,
      event: result.event,
    };
  }
  
  async postTrace(params: {
    conversationId: number;
    agentId: string;
    payload: TracePayload;
    turn?: number;
    clientRequestId?: string;
  }): Promise<{ conversation: number; seq: number; turn: number; event: number }> {
    const tracePayload = {
      ...params.payload,
      ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
    };
    
    const result = await this.call<any>('sendTrace', {
      conversationId: params.conversationId,
      agentId: params.agentId,
      tracePayload,
      ...(params.turn !== undefined ? { turn: params.turn } : {}),
    });
    return {
      conversation: result.conversation,
      seq: result.seq,
      turn: result.turn,
      event: result.event,
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

  async getAttachmentByDocId(params: { conversationId: number; docId: string }): Promise<AttachmentRow | null> {
    try {
      const row = await this.call<AttachmentRow>('getAttachmentByDocId', {
        conversationId: params.conversationId,
        docId: params.docId,
      });
      return row ?? null;
    } catch (e) {
      // 404 or other errors -> null
      return null;
    }
  }
}
