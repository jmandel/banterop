// src/agents/clients/ensure-client.ts
//
// Client-side agent ensure helper with localStorage persistence

import { WsEventStream } from '$src/agents/clients/event-stream';
import { WsJsonRpcClient } from '$src/agents/clients/ws.client';
import type { GuidanceEvent } from '$src/types/orchestrator.types';

export type Finality = 'none' | 'turn' | 'conversation';

export interface ClientEnsureOptions {
  conversationId: number;
  agentIds: string[];
  wsUrl?: string;              // derived by default
  storageKey?: string;         // default: '__client_agents__'
  onGuidance: (ctx: {
    conversationId: number;
    agentId: string;
    guidance: GuidanceEvent;
    sendMessage: (input: { 
      conversationId: number; 
      agentId: string; 
      text: string; 
      finality: Finality; 
      clientRequestId?: string; 
      turn?: number 
    }) => Promise<any>;
    getConversation: () => Promise<any>;
  }) => Promise<void> | void;
}

export interface ClientEnsureHandle { 
  stop: () => void;
}

interface StoredAgentEntry {
  conversationId: number;
  agentId: string;
  wsUrl?: string;
}

/**
 * Ensure agents running on the client with persistence
 */
export async function ensureAgentsRunningClient(opts: ClientEnsureOptions): Promise<{
  ensured: Array<{ agentId: string }>;
  handles: Record<string, ClientEnsureHandle>;
}> {
  const { 
    conversationId, 
    agentIds, 
    wsUrl = deriveWsUrl(), 
    storageKey = '__client_agents__',
    onGuidance 
  } = opts;

  const ensured: Array<{ agentId: string }> = [];
  const handles: Record<string, ClientEnsureHandle> = {};

  // De-duplicate agent IDs
  const uniqueAgentIds = Array.from(new Set(agentIds));

  for (const agentId of uniqueAgentIds) {
    // Create event stream and RPC client for this agent
    const stream = new WsEventStream(wsUrl, {
      conversationId,
      includeGuidance: true,
      filters: { agents: [agentId] }
    });

    const rpc = new WsJsonRpcClient({ url: wsUrl });

    // Create sendMessage helper bound to this conversation/agent
    const sendMessage = async (input: {
      conversationId: number;
      agentId: string;
      text: string;
      finality: Finality;
      clientRequestId?: string;
      turn?: number;
    }) => {
      return rpc.postMessage({
        conversationId: input.conversationId,
        agentId: input.agentId,
        text: input.text,
        finality: input.finality,
        clientRequestId: input.clientRequestId,
        turn: input.turn
      });
    };

    // Create getConversation helper
    const getConversation = async () => {
      return rpc.getSnapshot(conversationId);
    };

    // Start listening for guidance events
    let running = true;
    const runLoop = async () => {
      try {
        for await (const event of stream) {
          if (!running) break;
          
          if (event.type === 'guidance' && event.nextAgentId === agentId) {
            await onGuidance({
              conversationId,
              agentId,
              guidance: event as GuidanceEvent,
              sendMessage,
              getConversation
            });
          }
        }
      } catch (err) {
        console.error(`[ensureAgentsRunningClient] Error in agent ${agentId} loop:`, err);
      }
    };

    // Start the loop in background
    runLoop();

    // Persist to localStorage
    persistAgent({ conversationId, agentId, wsUrl }, storageKey);

    // Create handle for stopping
    handles[agentId] = {
      stop: () => {
        running = false;
        stream.close();
        rpc.close();
        unpersistAgent({ conversationId, agentId }, storageKey);
      }
    };

    ensured.push({ agentId });
  }

  return { ensured, handles };
}

/**
 * Auto-resume agents from localStorage on boot
 */
export function autoResumeAgents(options: {
  storageKey?: string;         // default: '__client_agents__'
  wsUrl?: string;              // optional override
  handlerFor: (agentId: string) => ClientEnsureOptions['onGuidance'];
  conversationIdFor: (agentId: string) => number;
}): void {
  const { 
    storageKey = '__client_agents__', 
    wsUrl,
    handlerFor,
    conversationIdFor
  } = options;

  if (typeof localStorage === 'undefined') {
    console.warn('[autoResumeAgents] localStorage not available');
    return;
  }

  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return;

    const entries: StoredAgentEntry[] = JSON.parse(stored);
    
    // Group by conversation
    const byConversation = new Map<number, string[]>();
    for (const entry of entries) {
      const convId = conversationIdFor(entry.agentId) ?? entry.conversationId;
      if (!byConversation.has(convId)) {
        byConversation.set(convId, []);
      }
      byConversation.get(convId)!.push(entry.agentId);
    }

    // Resume each conversation's agents
    for (const [conversationId, agentIds] of byConversation) {
      // Pick any agent to get the handler (assumes same handler for all)
      const handler = handlerFor(agentIds[0]!);
      
      ensureAgentsRunningClient({
        conversationId,
        agentIds,
        wsUrl: wsUrl || entries[0]?.wsUrl,
        storageKey,
        onGuidance: handler
      });
    }
  } catch (err) {
    console.error('[autoResumeAgents] Failed to resume agents:', err);
  }
}

// Helper functions for localStorage persistence

function persistAgent(entry: StoredAgentEntry, storageKey: string): void {
  if (typeof localStorage === 'undefined') return;

  try {
    const stored = localStorage.getItem(storageKey);
    const entries: StoredAgentEntry[] = stored ? JSON.parse(stored) : [];
    
    // Check if already exists
    const exists = entries.some(e => 
      e.conversationId === entry.conversationId && e.agentId === entry.agentId
    );
    
    if (!exists) {
      entries.push(entry);
      localStorage.setItem(storageKey, JSON.stringify(entries));
    }
  } catch (err) {
    console.error('[persistAgent] Failed to persist:', err);
  }
}

function unpersistAgent(entry: { conversationId: number; agentId: string }, storageKey: string): void {
  if (typeof localStorage === 'undefined') return;

  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return;

    const entries: StoredAgentEntry[] = JSON.parse(stored);
    const filtered = entries.filter(e => 
      !(e.conversationId === entry.conversationId && e.agentId === entry.agentId)
    );
    
    if (filtered.length === 0) {
      localStorage.removeItem(storageKey);
    } else {
      localStorage.setItem(storageKey, JSON.stringify(filtered));
    }
  } catch (err) {
    console.error('[unpersistAgent] Failed to unpersist:', err);
  }
}

function deriveWsUrl(): string {
  // Try to derive from current location or use default
  if (typeof window !== 'undefined' && window.location) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/api/ws`;
  }
  return 'ws://localhost:4280/api/ws';
}