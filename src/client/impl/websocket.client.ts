// WebSocket JSON-RPC Client Implementation (Universal)

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  ConversationEvent, SubscriptionOptions, TraceEntry,
  ConversationTurn, CreateConversationRequest, CreateConversationResponse
} from '$lib/types.js';
import type { OrchestratorClient } from '../index.js';

// --- Universal WebSocket Interface ---
// This defines a contract that both browser WebSocket and 'ws' package WebSocket adhere to.

// Universal WebSocket interface that works for both browser WebSocket and ws package
export interface IWebSocket extends EventTarget {
  readyState: number;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  
  // Event handlers - both browser and ws support these
  onopen: ((this: IWebSocket, ev: Event) => void) | null;
  onmessage: ((this: IWebSocket, ev: MessageEvent) => void) | null;
  onclose: ((this: IWebSocket, ev: CloseEvent & { code: number; reason: string }) => void) | null;
  onerror: ((this: IWebSocket, ev: Event) => void) | null;
}

// --- The Unified WebSocket Client ---

export class WebSocketJsonRpcClient extends EventEmitter implements OrchestratorClient {
  private ws?: IWebSocket;
  private url: string;
  private pendingRequests: Map<string | number, {
    resolve: (result: any) => void;
    reject: (error: any) => void;
  }>;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private authenticated = false;
  private authToken?: string;
  private disconnecting = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(url: string) {
    super();
    this.url = url;
    this.pendingRequests = new Map();
  }

  async connect(authToken?: string): Promise<void> {
    if (authToken) {
      this.authToken = authToken;
    }
    
    return new Promise((resolve, reject) => {
      try {
        // Use the injected WebSocket implementation
        this.ws = new WebSocket(this.url) as IWebSocket;

        this.ws.onopen = async () => {
          console.log('WebSocket connected');
          this.reconnectAttempts = 0;
          
          if (this.authToken) {
            try {
              await this.authenticate(this.authToken);
            } catch (error) {
              reject(error);
              return;
            }
          }
          
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onclose = (event) => {
          // Both browser and ws package CloseEvent have code and reason properties
          const closeEvent = event as CloseEvent & { code: number; reason: string };
          console.log('WebSocket closed:', closeEvent.code, closeEvent.reason);
          this.authenticated = false;
          
          if (closeEvent.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts && !this.disconnecting) {
            this.reconnectTimer = setTimeout(() => {
              this.reconnectAttempts++;
              console.log(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
              this.connect(this.authToken).catch(error => {
                console.warn('Reconnection attempt failed:', error);
                // Error is already emitted via the 'error' event, no need to throw
              });
            }, this.reconnectDelay * this.reconnectAttempts);
          }
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          this.emit('error', error);
          // Only reject if this is the initial connection attempt
          if (this.reconnectAttempts === 0) {
            reject(error);
          }
        };

      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    // Mark as disconnecting to prevent new requests
    this.disconnecting = true;
    
    // Clear any pending reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    
    // If no pending requests, close immediately
    if (this.pendingRequests.size === 0) {
      this.closeWebSocket();
    }
    // Otherwise, let pending requests complete naturally
    // The WebSocket will be closed when the last request is handled
  }

  private closeWebSocket(): void {
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = undefined;
    }
    this.authenticated = false;
    this.authToken = undefined;
    this.pendingRequests.clear();
  }

  private handleMessage(data: string | Buffer | ArrayBuffer | Blob): void {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.id !== undefined && this.pendingRequests.has(message.id)) {
        const { resolve, reject } = this.pendingRequests.get(message.id)!;
        this.pendingRequests.delete(message.id);
        
        if (message.error) {
          const error = new Error(message.error.message || JSON.stringify(message.error));
          (error as any).code = message.error.code;
          (error as any).data = message.error.data;
          reject(error);
        } else {
          resolve(message.result);
        }
        
        // If disconnecting and no more pending requests, close now
        if (this.disconnecting && this.pendingRequests.size === 0) {
          this.closeWebSocket();
        }
      } else if (message.method === 'event') {
        // Type-safe event emission - the event is a ConversationEvent
        const conversationEvent = message.params.event as ConversationEvent;
        const subscriptionId = message.params.subscriptionId as string;
        this.emit('event', conversationEvent, subscriptionId);
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  }

  private sendRequest(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.disconnecting) {
        reject(new Error('Client is disconnecting'));
        return;
      }
      
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const id = uuidv4();
      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      this.pendingRequests.set(id, { resolve, reject });
      
      this.ws.send(JSON.stringify(request));
      
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async authenticate(token: string): Promise<any> {
    const result = await this.sendRequest('authenticate', { token });
    this.authenticated = true;
    this.authToken = token;
    return result;
  }

  async createConversation(request: CreateConversationRequest): Promise<CreateConversationResponse> {
    return this.sendRequest('createConversation', request);
  }

  async startConversation(conversationId: string): Promise<void> {
    await this.sendRequest('startConversation', { conversationId });
  }

  async subscribe(conversationId: string, options?: SubscriptionOptions): Promise<string> {
    const result = await this.sendRequest('subscribe', { conversationId, options });
    return result.subscriptionId;
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    return this.sendRequest('unsubscribe', { subscriptionId });
  }

  async unsubscribeAll(): Promise<void> {
    return this.sendRequest('unsubscribeAll');
  }

  async startTurn(metadata?: Record<string, any>): Promise<string> {
    const result = await this.sendRequest('startTurn', { metadata });
    return result.turnId;
  }

  async addTrace(turnId: string, entry: Omit<TraceEntry, 'id' | 'timestamp' | 'agentId'>): Promise<void> {
    return this.sendRequest('addTrace', { turnId, entry });
  }

  async completeTurn(turnId: string, content: string, isFinalTurn?: boolean, metadata?: Record<string, any>, attachments?: string[]): Promise<ConversationTurn> {
    return this.sendRequest('completeTurn', { turnId, content, isFinalTurn, metadata, attachments });
  }

  async registerAttachment(params: {
    conversationId: string;
    turnId: string;
    docId?: string;
    name: string;
    contentType: string;
    content: string;
    summary?: string;
    createdByAgentId: string;
  }): Promise<string> {
    const result = await this.sendRequest('registerAttachment', params);
    return result.attachmentId;
  }

  async getAttachment(attachmentId: string): Promise<Attachment | null> {
    const result = await this.sendRequest('getAttachment', { attachmentId });
    return result;
  }

  async getAttachmentByDocId(conversationId: string, docId: string): Promise<Attachment | null> {
    const result = await this.sendRequest('getAttachmentByDocId', { conversationId, docId });
    return result;
  }

  async createUserQuery(question: string, context?: Record<string, any>, timeout?: number): Promise<string> {
    return this.sendRequest('createUserQuery', { question, context, timeout });
  }

  async respondToUserQuery(queryId: string, response: string): Promise<void> {
    return this.sendRequest('respondToUserQuery', { queryId, response });
  }

  async getConversation(conversationId?: string, options?: {
    includeTurns?: boolean;
    includeTrace?: boolean;
    includeInProgress?: boolean;
  }): Promise<any> {
    return this.sendRequest('getConversation', { 
      conversationId, 
      ...options
    });
  }

  async getAllConversations(options?: { 
    limit?: number; 
    offset?: number; 
    includeTurns?: boolean; 
    includeTrace?: boolean;
  }): Promise<{ conversations: any[]; total: number; limit: number; offset: number }> {
    return this.sendRequest('getAllConversations', options);
  }

  // Method from the old node-specific client, for completeness.
  async getPendingUserQueries(conversationId?: string): Promise<{ queries: any[], count: number }> {
    return this.sendRequest('getPendingUserQueries', { conversationId });
  }

  async getAllPendingUserQueries(): Promise<{ queries: any[], count: number }> {
    return this.sendRequest('getAllPendingUserQueries');
  }

  async endConversation(conversationId?: string): Promise<void> {
    return this.sendRequest('endConversation', { conversationId });
  }
}