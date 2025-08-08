import { ConversationSnapshot } from "$src/types";
import type { IAgentClient } from "$src/agents/agent.types";
import type { MessagePayload, TracePayload } from "$src/types/event.types";

/**
 * WebSocket JSON-RPC client for external agent execution
 * Provides subscription management and event handling
 * Implements IAgentClient for use with external.executor.ts
 * 
 * Note: For IAgentTransport implementation, use WsTransport from runtime/ws.transport.ts
 */
export class WsJsonRpcClient implements IAgentClient {
  private ws?: WebSocket;
  private pending = new Map<string, (result: any) => void>();
  private subId?: string;
  private conversationId?: number;
  public latestSeqSeen = 0;
  private onEvent?: (event: any) => void;

  constructor(opts: { url: string; onEvent?: (e: any) => void; reconnect?: boolean; agentId?: string }) {
    this.onEvent = opts.onEvent;
    this.connectWebSocket(opts.url);
  }

  private connectWebSocket(url: string): void {
    this.ws = new WebSocket(url);
    
    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data));
        
        // Handle RPC responses
        if (msg.id && this.pending.has(msg.id)) {
          const resolver = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          resolver(msg.result ?? msg.error);
          return;
        }
        
        // Handle push events
        if (msg.method === 'event' && msg.params) {
          const event = msg.params;
          if (event.seq) {
            this.latestSeqSeen = Math.max(this.latestSeqSeen, event.seq);
          }
          this.onEvent?.(event);
        }
      } catch {}
    };
  }

  private async call<T>(method: string, params?: any): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.waitForConnection();
    }
    
    return new Promise<T>((resolve) => {
      const id = crypto.randomUUID();
      this.pending.set(id, (result) => resolve(result as T));
      this.ws!.send(JSON.stringify({ id, method, params, jsonrpc: '2.0' }));
    });
  }

  private async waitForConnection(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    
    return new Promise((resolve) => {
      const check = () => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  async ensureSubscribed(conversationId: number): Promise<void> {
    this.conversationId = conversationId;
    const result = await this.call<any>('subscribe', { 
      conversationId, 
      includeGuidance: true 
    });
    this.subId = result?.subId;
  }

  async unsubscribe(): Promise<void> {
    if (this.subId) {
      await this.call('unsubscribe', { subId: this.subId });
      this.subId = undefined;
    }
  }

  async getSnapshot(conversationId: number): Promise<any> {
    const snap = await this.call('getConversation', { 
      conversationId,
      includeScenario: true
    }) as ConversationSnapshot;
    
    // Update latestSeqSeen from snapshot
    if (snap?.events?.length) {
      const lastEvent = snap.events[snap.events.length - 1];
      if (lastEvent?.seq) {
        this.latestSeqSeen = Math.max(this.latestSeqSeen, lastEvent.seq);
      }
    }
    
    return snap;
  }

  async waitForChange(conversationId: number, sinceSeq: number, timeoutMs: number): Promise<{ timedOut: boolean; latestSeq: number }> {
    // Since we have push events via subscription, we can just wait for timeout
    // This is mainly for periodic reconciliation
    await new Promise(resolve => setTimeout(resolve, timeoutMs));
    return { timedOut: true, latestSeq: this.latestSeqSeen };
  }

  async postMessage(params: {
    conversationId: number; 
    agentId: string; 
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    attachments?: NonNullable<MessagePayload['attachments']>;
    clientRequestId?: string;
    turn?: number;
  }): Promise<{ seq: number; turn: number; event: number }> {
    const result = await this.call<any>('sendMessage', {
      conversationId: params.conversationId,
      agentId: params.agentId,
      messagePayload: { 
        text: params.text,
        ...(params.attachments ? { attachments: params.attachments } : {}),
        ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {})
      },
      finality: params.finality,
      ...(params.turn !== undefined ? { turn: params.turn } : {})
    });
    
    // Return in the expected format
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
  }): Promise<{ seq: number; turn: number; event: number }> {
    const result = await this.call<any>('sendTrace', {
      conversationId: params.conversationId,
      agentId: params.agentId,
      tracePayload: {
        ...params.payload,
        ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {})
      },
      ...(params.turn !== undefined ? { turn: params.turn } : {})
    });
    
    // Return in the expected format
    return {
      seq: result.seq || 0,
      turn: result.turn || 0,
      event: result.event || 0
    };
  }
  
  now(): number {
    return Date.now();
  }

  close(): void {
    this.ws?.close();
    this.ws = undefined;
  }
}

// Note: For the IAgentTransport implementation, use WsTransport from runtime/ws.transport.ts
// This file only contains WsJsonRpcClient for external.executor.ts
