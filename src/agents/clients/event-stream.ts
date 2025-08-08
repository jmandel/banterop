import type { UnifiedEvent } from '$src/types/event.types';
import type { GuidanceEvent } from '$src/types/orchestrator.types';

export type StreamEvent = UnifiedEvent | GuidanceEvent;

export interface EventStreamOptions {
  conversationId: number;
  includeGuidance?: boolean;
  reconnectDelayMs?: number;
  heartbeatIntervalMs?: number;
  filters?: { types?: Array<'message'|'trace'|'system'>; agents?: string[] };
  sinceSeq?: number;
}

/**
 * WebSocket-based event stream client
 * Provides an async iterator over conversation events with automatic reconnection
 */
export class WsEventStream {
  private ws: WebSocket | undefined;
  private queue: StreamEvent[] = [];
  private resolvers: Array<(value: IteratorResult<StreamEvent>) => void> = [];
  private closed = false;
  private subId: string | undefined;
  private connected = false;
  private reconnectTimer: Timer | undefined;
  private heartbeatTimer: Timer | undefined;
  // Optional UI callback for connection state changes
  public onStateChange?: (state: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
  
  constructor(
    private url: string,
    private options: EventStreamOptions
  ) {}
  
  private async connect(): Promise<void> {
    if (this.closed) throw new Error('Stream is closed');
    if (this.connected) return;
    
    return new Promise((resolve, reject) => {
      this.onStateChange?.('connecting');
      const ws = new WebSocket(this.url);
      this.ws = ws;
      
      ws.onopen = async () => {
        this.connected = true;
        this.onStateChange?.('open');
        
        // Subscribe to events
        const subReq = {
          id: crypto.randomUUID(),
          method: 'subscribe',
          params: {
            conversationId: this.options.conversationId,
            includeGuidance: this.options.includeGuidance ?? false,
            ...(this.options.filters ? { filters: this.options.filters } : {}),
            ...(typeof this.options.sinceSeq === 'number' ? { sinceSeq: this.options.sinceSeq } : {}),
          },
          jsonrpc: '2.0',
        };
        
        console.log(`[WsEventStream] Sending subscribe request:`, JSON.stringify(subReq));
        ws.send(JSON.stringify(subReq));
        
        // Start heartbeat
        this.startHeartbeat();
        resolve();
      };
      
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string);
          
          // Handle subscription response
          if (msg.id && msg.result?.subId) {
            this.subId = msg.result.subId;
            console.log(`[WsEventStream] Subscription confirmed, subId=${this.subId}`);
            return;
          }
          
          // Handle events and guidance
          if (msg.method === 'event' || msg.method === 'guidance') {
            const event = msg.params as StreamEvent;
            console.log(`[WsEventStream] Received ${msg.method}:`, JSON.stringify(event).substring(0, 100));
            this.enqueue(event);
          }
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      };
      
      ws.onclose = () => {
        this.connected = false;
        this.stopHeartbeat();
        
        if (!this.closed && this.options.reconnectDelayMs !== 0) {
          // Schedule reconnection
          const delay = this.options.reconnectDelayMs ?? 1000;
          this.onStateChange?.('reconnecting');
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch(console.error);
          }, delay);
        }
      };
      
      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        if (!this.connected) {
          reject(err);
        }
      };
    });
  }
  
  private startHeartbeat() {
    const interval = this.options.heartbeatIntervalMs ?? 15000;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Send a ping to keep connection alive
        this.ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          method: 'ping',
          jsonrpc: '2.0',
        }));
      }
    }, interval);
  }
  
  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
  
  private enqueue(event: StreamEvent) {
    this.queue.push(event);
    
    // Notify waiting consumers
    const resolver = this.resolvers.shift();
    if (resolver) {
      const item = this.queue.shift();
      if (item) {
        resolver({ value: item, done: false });
      }
    }
  }
  
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    // Ensure connected
    await this.connect();
    
    while (!this.closed) {
      // Check queue first
      if (this.queue.length > 0) {
        const event = this.queue.shift()!;
        yield event;
        
        // Check for conversation end
        if ('type' in event && event.type === 'message') {
          const msg = event as UnifiedEvent;
          if (msg.finality === 'conversation') {
            this.close();
            return;
          }
        }
      } else {
        // Wait for next event
        const event = await new Promise<StreamEvent | null>((resolve) => {
          if (this.closed) {
            resolve(null);
          } else {
            this.resolvers.push((result) => {
              if (result.done) {
                resolve(null);
              } else {
                resolve(result.value);
              }
            });
          }
        });
        
        if (event) {
          yield event;
          
          // Check for conversation end
          if ('type' in event && event.type === 'message') {
            const msg = event as UnifiedEvent;
            if (msg.finality === 'conversation') {
              this.close();
              return;
            }
          }
        } else {
          return;
        }
      }
    }
  }
  
  close() {
    this.closed = true;
    
    // Clear timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.stopHeartbeat();
    
    // Unsubscribe if we have a subscription
    if (this.subId && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        method: 'unsubscribe',
        params: { subId: this.subId },
        jsonrpc: '2.0',
      }));
    }
    
    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    this.onStateChange?.('closed');
    
    // Resolve any waiting consumers
    for (const resolver of this.resolvers) {
      resolver({ value: undefined as any, done: true });
    }
    this.resolvers = [];
  }
}

/**
 * In-process event stream for internal executors
 * Wraps the orchestrator's subscription bus
 */
export class InProcessEventStream {
  private queue: StreamEvent[] = [];
  private resolvers: Array<(value: IteratorResult<StreamEvent>) => void> = [];
  private closed = false;
  private subId: string | undefined;
  
  constructor(
    private orchestrator: {
      subscribe(conversation: number, listener: (e: StreamEvent) => void, includeGuidance: boolean): string;
      unsubscribe(subId: string): void;
    },
    private options: EventStreamOptions
  ) {}
  
  private subscribe() {
    if (this.subId) return;
    
    this.subId = this.orchestrator.subscribe(
      this.options.conversationId,
      (event: StreamEvent) => {
        this.enqueue(event);
      },
      this.options.includeGuidance ?? false
    );
  }
  
  private enqueue(event: StreamEvent) {
    this.queue.push(event);
    
    // Notify waiting consumers
    const resolver = this.resolvers.shift();
    if (resolver) {
      const item = this.queue.shift();
      if (item) {
        resolver({ value: item, done: false });
      }
    }
  }
  
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    // Subscribe to events
    this.subscribe();
    
    while (!this.closed) {
      // Check queue first
      if (this.queue.length > 0) {
        const event = this.queue.shift()!;
        yield event;
        
        // Check for conversation end
        if ('type' in event && event.type === 'message') {
          const msg = event as UnifiedEvent;
          if (msg.finality === 'conversation') {
            this.close();
            return;
          }
        }
      } else {
        // Wait for next event
        const event = await new Promise<StreamEvent | null>((resolve) => {
          if (this.closed) {
            resolve(null);
          } else {
            this.resolvers.push((result) => {
              if (result.done) {
                resolve(null);
              } else {
                resolve(result.value);
              }
            });
          }
        });
        
        if (event) {
          yield event;
          
          // Check for conversation end
          if ('type' in event && event.type === 'message') {
            const msg = event as UnifiedEvent;
            if (msg.finality === 'conversation') {
              this.close();
              return;
            }
          }
        } else {
          return;
        }
      }
    }
  }
  
  close() {
    this.closed = true;
    
    // Unsubscribe
    if (this.subId) {
      this.orchestrator.unsubscribe(this.subId);
      this.subId = undefined;
    }
    
    // Resolve any waiting consumers
    for (const resolver of this.resolvers) {
      resolver({ value: undefined as any, done: true });
    }
    this.resolvers = [];
  }
}

/**
 * Helper to create the appropriate event stream based on context
 */
export function createEventStream(
  contextOrUrl: string | { subscribe: any; unsubscribe: any },
  options: EventStreamOptions
): AsyncIterable<StreamEvent> {
  if (typeof contextOrUrl === 'string') {
    // WebSocket URL provided
    return new WsEventStream(contextOrUrl, options);
  } else {
    // Orchestrator instance provided
    return new InProcessEventStream(contextOrUrl, options);
  }
}
