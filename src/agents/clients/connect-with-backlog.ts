/**
 * Recommended race-free pattern (Option A):
 * 1) Fetch backlog page(s) up to a snapshot (now).
 * 2) Determine lastSeq from backlog.
 * 3) Subscribe with sinceSeq = lastSeq to receive only newer events.
 *
 * This helper does the above and returns:
 * - backlog: UnifiedEvent[] (already filtered/paged as requested)
 * - stream: WsEventStream subscribed from lastSeq forward
 */

import { UnifiedEvent } from '$src/types/event.types';
import { WsEventStream } from './event-stream';

export interface ConnectWithBacklogOptions {
  conversationId: number;
  includeGuidance?: boolean;
  filters?: { 
    types?: Array<'message' | 'trace' | 'system'>; 
    agents?: string[] 
  };
  pageLimit?: number;
}

export interface BacklogRpcClient {
  call<T>(method: string, params?: any): Promise<T>;
}

export interface BacklogResult {
  backlog: UnifiedEvent[];
  stream: WsEventStream;
  nextAfterSeq?: number;
}

/**
 * Connect to a conversation with a race-free backlog fetch pattern.
 * This ensures no events are missed or duplicated between the historical
 * backlog and the live stream.
 * 
 * @param wsUrl - WebSocket URL for the event stream
 * @param rpcClient - RPC client for fetching backlog
 * @param options - Connection options including conversation ID and filters
 * @returns Promise with backlog events and connected stream
 * 
 * @example
 * ```ts
 * // Create a minimal RPC client (can reuse existing ClaimClient)
 * const rpc = {
 *   call: <T,>(method: string, params?: any) => {
 *     // Implement a tiny one-shot JSON-RPC call using a transient WebSocket
 *     // or reuse an existing ClaimClient as in turn-loop-executor.external.ts
 *   }
 * };
 * 
 * const { backlog, stream } = await connectWithBacklog(wsUrl, rpc, {
 *   conversationId: 42,
 *   includeGuidance: true,
 *   filters: { types: ['message'], agents: ['assistant'] },
 * });
 * 
 * // Consume backlog first, then live stream
 * for (const ev of backlog) {
 *   handle(ev);
 * }
 * for await (const ev of stream) {
 *   handle(ev);
 * }
 * ```
 */
export async function connectWithBacklog(
  wsUrl: string,
  rpcClient: BacklogRpcClient,
  options: ConnectWithBacklogOptions
): Promise<BacklogResult> {
  const pageLimit = options.pageLimit ?? 200;
  const convoId = options.conversationId;

  // 1) Fetch a single page of backlog (or loop if needed for multiple pages)
  const page = await rpcClient.call<{ 
    events: UnifiedEvent[]; 
    nextAfterSeq?: number 
  }>('getEventsPage', { 
    conversationId: convoId, 
    limit: pageLimit 
  });

  // Optional client-side filtering to mirror the subscription filters
  const filteredBacklog = page.events.filter((ev) => {
    if (options.filters?.types && !options.filters.types.includes(ev.type)) {
      return false;
    }
    if (options.filters?.agents && !options.filters.agents.includes(ev.agentId)) {
      return false;
    }
    return true;
  });

  // 2) Determine lastSeq from backlog
  const lastSeq = filteredBacklog.length > 0 
    ? filteredBacklog[filteredBacklog.length - 1]!.seq 
    : undefined;

  // 3) Subscribe from lastSeq forward
  const stream = new WsEventStream(wsUrl, {
    conversationId: convoId,
    includeGuidance: options.includeGuidance ?? false,
    ...(options.filters ? { filters: options.filters } : {}),
    ...(lastSeq !== undefined ? { sinceSeq: lastSeq } : {}), // critical to avoid gaps/dupes
  });

  return { 
    backlog: filteredBacklog, 
    stream, 
    ...(page.nextAfterSeq !== undefined ? { nextAfterSeq: page.nextAfterSeq } : {})
  };
}

/**
 * Simple one-shot RPC client implementation for WebSocket JSON-RPC.
 * This can be used as the rpcClient parameter for connectWithBacklog.
 * 
 * @param wsUrl - WebSocket URL for RPC
 * @returns BacklogRpcClient implementation
 * 
 * @example
 * ```ts
 * const rpc = createSimpleRpcClient('ws://localhost:3000/api/ws');
 * const result = await rpc.call('getEventsPage', { conversationId: 1 });
 * ```
 */
export function createSimpleRpcClient(wsUrl: string): BacklogRpcClient {
  return {
    async call<T>(method: string, params?: any): Promise<T> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const id = crypto.randomUUID();
        
        ws.onopen = () => {
          ws.send(JSON.stringify({ 
            jsonrpc: '2.0', 
            id, 
            method, 
            params 
          }));
        };
        
        ws.onmessage = (evt) => {
          const msg = JSON.parse(String(evt.data));
          if (msg.id !== id) return;
          ws.close();
          
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve(msg.result as T);
          }
        };
        
        ws.onerror = (err) => {
          reject(err);
        };
      });
    }
  };
}