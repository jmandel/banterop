// src/client/client-api.ts
//
// Client-side API for interacting with the server
// Provides EventStream, RPC calls, and conversation management

import type { UnifiedEvent } from '$src/types/event.types';
import type { GuidanceEvent } from '$src/types/orchestrator.types';

export interface EventStreamOptions {
  conversationId?: number;
  includeGuidance?: boolean;
}

/**
 * Create an async iterable event stream from the server
 */
export async function* createEventStream(
  wsUrl: string,
  options: EventStreamOptions,
  signal?: AbortSignal
): AsyncIterable<UnifiedEvent | GuidanceEvent> {
  const ws = new WebSocket(wsUrl);
  const messageQueue: (UnifiedEvent | GuidanceEvent)[] = [];
  let resolveNext: ((value: IteratorResult<UnifiedEvent | GuidanceEvent>) => void) | null = null;
  let closed = false;
  
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'event' || data.type === 'guidance') {
        if (resolveNext) {
          resolveNext({ value: data, done: false });
          resolveNext = null;
        } else {
          messageQueue.push(data);
        }
      }
    } catch (error) {
      console.error('[createEventStream] Failed to parse message:', error);
    }
  };
  
  ws.onerror = (error) => {
    console.error('[createEventStream] WebSocket error:', error);
    closed = true;
    if (resolveNext) {
      resolveNext({ value: undefined as any, done: true });
      resolveNext = null;
    }
  };
  
  ws.onclose = () => {
    closed = true;
    if (resolveNext) {
      resolveNext({ value: undefined as any, done: true });
      resolveNext = null;
    }
  };
  
  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      // Subscribe to events
      const subscribeMsg = {
        jsonrpc: '2.0',
        method: options.conversationId ? 'subscribe' : 'subscribeAll',
        params: options.conversationId 
          ? { conversationId: options.conversationId, includeGuidance: options.includeGuidance }
          : { includeGuidance: options.includeGuidance },
        id: crypto.randomUUID()
      };
      ws.send(JSON.stringify(subscribeMsg));
      resolve();
    };
    
    // Handle abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        ws.close();
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }
  });
  
  // Yield messages
  while (!closed) {
    if (messageQueue.length > 0) {
      yield messageQueue.shift()!;
    } else {
      // Wait for next message
      const result = await new Promise<IteratorResult<UnifiedEvent | GuidanceEvent>>((resolve) => {
        resolveNext = resolve;
      });
      if (result.done) break;
      yield result.value;
    }
  }
  
  ws.close();
}

/**
 * Send a message to the server
 */
export async function sendMessage(
  wsUrl: string,
  params: {
    conversationId: number;
    agentId: string;
    text: string;
    finality: 'none' | 'turn' | 'conversation';
    clientRequestId?: string;
    turn?: number;
  }
): Promise<any> {
  const ws = new WebSocket(wsUrl);
  
  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      const msg = {
        jsonrpc: '2.0',
        method: 'sendMessage',
        params,
        id: crypto.randomUUID()
      };
      ws.send(JSON.stringify(msg));
    };
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.error) {
          reject(new Error(data.error.message));
        } else {
          resolve(data.result);
        }
        ws.close();
      } catch (error) {
        reject(error);
        ws.close();
      }
    };
    
    ws.onerror = (error) => {
      reject(error);
      ws.close();
    };
  });
}

/**
 * Get conversation snapshot from the server
 */
export async function getConversation(
  wsUrl: string,
  conversationId: number
): Promise<any> {
  const ws = new WebSocket(wsUrl);
  
  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      const msg = {
        jsonrpc: '2.0',
        method: 'getConversation',
        params: { conversationId },
        id: crypto.randomUUID()
      };
      ws.send(JSON.stringify(msg));
    };
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.error) {
          reject(new Error(data.error.message));
        } else {
          resolve(data.result);
        }
        ws.close();
      } catch (error) {
        reject(error);
        ws.close();
      }
    };
    
    ws.onerror = (error) => {
      reject(error);
      ws.close();
    };
  });
}

/**
 * Call any RPC method on the server
 */
export async function rpcCall<T = any>(
  wsUrl: string,
  method: string,
  params?: any
): Promise<T> {
  const ws = new WebSocket(wsUrl);
  
  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      const msg = {
        jsonrpc: '2.0',
        method,
        params,
        id: crypto.randomUUID()
      };
      ws.send(JSON.stringify(msg));
    };
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.error) {
          reject(new Error(data.error.message));
        } else {
          resolve(data.result);
        }
        ws.close();
      } catch (error) {
        reject(error);
        ws.close();
      }
    };
    
    ws.onerror = (error) => {
      reject(error);
      ws.close();
    };
  });
}