// src/client/ensure-agents.ts
//
// Client-side agent management with localStorage persistence
// Provides ergonomic API matching server-side ensureAgentsRunning

import type { GuidanceEvent } from '$src/types/orchestrator.types';
import { createEventStream, sendMessage, getConversation } from './client-api';

type Finality = 'none' | 'turn' | 'conversation';

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

interface StoredAgent {
  conversationId: number;
  agentId: string;
  wsUrl?: string;
}

/**
 * Ensure agents are running on the client with localStorage persistence
 * Matches server-side ergonomics but runs agents locally
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
  
  // Load existing storage
  const stored = loadStoredAgents(storageKey);
  
  for (const agentId of agentIds) {
    // Create event stream for this agent
    const abortController = new AbortController();
    const stream = createEventStream(wsUrl, { 
      conversationId, 
      includeGuidance: true 
    }, abortController.signal);
    
    // Start processing loop
    (async () => {
      try {
        for await (const ev of stream) {
          if (ev.type === 'guidance' && ev.nextAgentId === agentId) {
            await onGuidance({
              conversationId,
              agentId,
              guidance: ev,
              sendMessage: async (input) => sendMessage(wsUrl, input),
              getConversation: async () => getConversation(wsUrl, conversationId)
            });
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.error(`[ensureAgentsRunningClient] Error in agent ${agentId}:`, error);
        }
      }
    })();
    
    // Store in localStorage
    const agentRecord: StoredAgent = { conversationId, agentId, wsUrl };
    stored.push(agentRecord);
    
    // Create handle
    handles[agentId] = {
      stop: () => {
        abortController.abort();
        // Remove from storage
        const updated = loadStoredAgents(storageKey)
          .filter(a => !(a.conversationId === conversationId && a.agentId === agentId));
        saveStoredAgents(storageKey, updated);
      }
    };
    
    ensured.push({ agentId });
  }
  
  // Save updated storage
  saveStoredAgents(storageKey, stored);
  
  return { ensured, handles };
}

/**
 * Auto-resume agents from localStorage on page load
 * Call this once at app initialization
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
  
  const stored = loadStoredAgents(storageKey);
  
  // Group by conversation
  const byConversation = new Map<number, string[]>();
  for (const agent of stored) {
    const convId = agent.conversationId;
    if (!byConversation.has(convId)) {
      byConversation.set(convId, []);
    }
    byConversation.get(convId)!.push(agent.agentId);
  }
  
  // Resume each conversation's agents
  for (const [conversationId, agentIds] of byConversation) {
    // Find a handler for the first agent (assuming same handler for all in conversation)
    const handler = handlerFor(agentIds[0]!);
    
    ensureAgentsRunningClient({
      conversationId,
      agentIds,
      wsUrl: wsUrl || stored[0]?.wsUrl,
      storageKey,
      onGuidance: handler
    }).catch(error => {
      console.error(`[autoResumeAgents] Failed to resume agents for conversation ${conversationId}:`, error);
    });
  }
}

// Helper functions for localStorage

function loadStoredAgents(storageKey: string): StoredAgent[] {
  try {
    const data = localStorage.getItem(storageKey);
    if (!data) return [];
    return JSON.parse(data) as StoredAgent[];
  } catch {
    return [];
  }
}

function saveStoredAgents(storageKey: string, agents: StoredAgent[]): void {
  try {
    // De-duplicate by conversationId + agentId
    const unique = new Map<string, StoredAgent>();
    for (const agent of agents) {
      const key = `${agent.conversationId}-${agent.agentId}`;
      unique.set(key, agent);
    }
    localStorage.setItem(storageKey, JSON.stringify(Array.from(unique.values())));
  } catch (error) {
    console.error('[saveStoredAgents] Failed to save to localStorage:', error);
  }
}

function deriveWsUrl(): string {
  // Derive WebSocket URL from current location
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}