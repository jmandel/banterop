import { create } from 'zustand';
import type { WebSocketJsonRpcClient } from '$client/impl/websocket.client.js';
import type { ConversationEvent, ConversationTurn, TraceEntry } from '$lib/types.js';
import type { EventLogEntry, ConversationSummary } from '../types/index.js';

interface ConversationState {
  conversations: Map<string, ConversationSummary>;
  conversationTurns: Map<string, ConversationTurn[]>;
  events: EventLogEntry[];
  activeTab: string;
  expandedTraces: Set<string>;
  expandedConversations: Set<string>;
  totalMessages: number;
  totalEvents: number;
  eventFilter: string;
  updateVersion: number;
  
  loadConversations: (client: WebSocketJsonRpcClient) => Promise<void>;
  handleEvent: (event: ConversationEvent, conversationId: string) => void;
  addEvent: (message: string, type?: 'info' | 'error') => void;
  clearEvents: () => void;
  setActiveTab: (tabId: string) => void;
  toggleTrace: (turnId: string) => void;
  toggleConversation: (conversationId: string) => void;
  setEventFilter: (filter: string) => void;
}

let nextEventId = 0;

export const conversationStore = create<ConversationState>((set, get) => ({
  conversations: new Map(),
  conversationTurns: new Map(),
  events: [],
  activeTab: '*',
  expandedTraces: new Set(),
  expandedConversations: new Set(),
  totalMessages: 0,
  totalEvents: 0,
  eventFilter: '',
  updateVersion: 0,

  loadConversations: async (client: WebSocketJsonRpcClient) => {
    try {
      const result = await client.getAllConversations({
        limit: 10,
        includeTurns: false,
        includeTrace: false
      });

      const conversations = result.conversations || [];
      const newConversations = new Map<string, ConversationSummary>();
      const newTurns = new Map<string, ConversationTurn[]>();

      for (const conv of conversations) {
        const summary: ConversationSummary = {
          id: conv.id,
          createdAt: conv.createdAt,
          status: conv.status,
          agents: conv.agents || [],
          metadata: conv.metadata || {}
        };
        
        newConversations.set(conv.id, summary);

        try {
          const fullConv = await client.getConversation(conv.id, {
            includeTurns: true,
            includeTrace: true
          });

          if (fullConv) {
            summary.agents = fullConv.agents?.map(agent => 
              typeof agent === 'string' ? agent : agent.id
            ) || [];

            if (fullConv.turns && fullConv.turns.length > 0) {
              newTurns.set(conv.id, fullConv.turns);
              summary.turnCount = fullConv.turns.length;
              summary.lastActivity = new Date(
                fullConv.turns[fullConv.turns.length - 1].timestamp
              );
            }
          }
        } catch (error) {
          console.error(`Failed to load details for conversation ${conv.id}:`, error);
        }
      }

      set({ 
        conversations: newConversations,
        conversationTurns: newTurns
      });

      get().addEvent(`Loaded ${conversations.length} conversations`);
    } catch (error) {
      get().addEvent('Failed to load conversations: ' + (error as Error).message, 'error');
    }
  },

  handleEvent: (event: ConversationEvent, subscriptionId: string) => {
    const conversationId = event.conversationId;
    if (!conversationId) return;
    
    // Log event order to understand the flow
    console.log(`📍 EVENT: ${event.type}`, {
      conversationId: conversationId.slice(0, 8),
      turnId: event.data?.turnId || event.data?.turn?.id,
      agentId: event.data?.agentId,
      hasTrace: !!event.data?.entry,
      data: event.data
    });

    const { conversations, conversationTurns, addEvent } = get();
    
    // If any event has a turnId, ensure the turn exists first
    if (event.data?.turnId && event.type !== 'turn_started' && event.type !== 'turn_completed') {
      const turns = conversationTurns.get(conversationId) || [];
      const turnExists = turns.some(t => t.id === event.data.turnId);
      
      if (!turnExists) {
        console.log(`⚠️ Turn ${event.data.turnId} doesn't exist yet, creating from ${event.type} event`);
        
        set(state => {
          const newTurns = new Map(state.conversationTurns);
          const turns = newTurns.get(conversationId) || [];
          
          const newTurn: ConversationTurn = {
            id: event.data.turnId,
            conversationId: conversationId,
            agentId: event.data.agentId || 'unknown',
            timestamp: new Date(),
            content: '',
            status: 'in_progress',
            startedAt: new Date(),
            trace: []
          };
          
          turns.push(newTurn);
          newTurns.set(conversationId, [...turns]);
          
          return {
            conversationTurns: new Map(newTurns),
            updateVersion: state.updateVersion + 1
          };
        });
      }
    }

    if (!conversations.has(conversationId) && subscriptionId === '*') {
      set(state => {
        const newConversations = new Map(state.conversations);
        newConversations.set(conversationId, {
          id: conversationId,
          status: 'active',
          createdAt: new Date().toISOString(),
          agents: [],
          metadata: {
            conversationTitle: `Discovered ${conversationId.slice(0, 8)}...`
          }
        });
        return { conversations: newConversations };
      });
    }

    switch (event.type) {
      case 'conversation_created':
        const convData = event.data.conversation;
        addEvent(`New conversation created: ${convData.name || 'Unnamed'}`);
        
        // Update the conversation name if it was previously discovered
        set(state => {
          const newConversations = new Map(state.conversations);
          const existing = newConversations.get(conversationId);
          
          if (existing && existing.metadata?.conversationTitle?.startsWith('Discovered')) {
            newConversations.set(conversationId, {
              ...existing,
              metadata: convData.metadata || { conversationTitle: `Conversation ${conversationId.slice(0, 8)}...` },
              createdAt: convData.createdAt || existing.createdAt,
              status: convData.status || existing.status,
              agents: convData.agents || existing.agents
            });
            
            return { conversations: newConversations };
          }
          
          return state;
        });
        break;

      case 'turn_started':
        if (event.data.turn) {
          console.log('🚀 TURN_STARTED:', event.data.turn.id, 'agent:', event.data.turn.agentId);
          addEvent(`🚀 Turn started: ${event.data.turn.agentId}`);
          
          set(state => {
            const newTurns = new Map(state.conversationTurns);
            const turns = newTurns.get(conversationId) || [];
            const existingIndex = turns.findIndex(t => t.id === event.data.turn.id);
            
            // Initialize turn with empty trace array if not exists
            const turnWithTrace = { 
              ...event.data.turn, 
              trace: event.data.turn.trace || [] 
            };
            
            if (existingIndex >= 0) {
              turns[existingIndex] = turnWithTrace;
            } else {
              turns.push(turnWithTrace);
            }
            
            newTurns.set(conversationId, [...turns]);
            
            // Don't add to expandedTraces since we inverted the logic (traces show by default)
            
            return { 
              conversationTurns: new Map(newTurns),
              totalMessages: state.totalMessages + 1,
              updateVersion: state.updateVersion + 1
            };
          });
        }
        break;
        
      case 'turn_completed':
        if (event.data.turn) {
          set(state => {
            const newTurns = new Map(state.conversationTurns);
            const turns = newTurns.get(conversationId) || [];
            const existingIndex = turns.findIndex(t => t.id === event.data.turn.id);
            
            if (existingIndex >= 0) {
              // Preserve existing traces when updating completed turn
              const existingTurn = turns[existingIndex];
              turns[existingIndex] = {
                ...event.data.turn,
                trace: event.data.turn.trace || existingTurn.trace || []
              };
            } else {
              turns.push(event.data.turn);
            }
            
            newTurns.set(conversationId, [...turns]);
            
            return { 
              conversationTurns: new Map(newTurns),
              totalMessages: state.totalMessages + 1,
              updateVersion: state.updateVersion + 1
            };
          });
        }
        break;

      case 'trace_added':
        // Handle the actual data structure: {turn: {...}, trace: {...}}
        const turnId = event.data.turn?.id || event.data.turnId;
        const traceEntry = event.data.trace || event.data.entry;
        
        if (!turnId) {
          console.log('❌ TRACE_ADDED missing turnId!', event.data);
        }
        if (!traceEntry) {
          console.log('❌ TRACE_ADDED missing trace entry!', event.data);
        }
        
        if (turnId && traceEntry) {
          console.log(`🔷 TRACE_ADDED: ${traceEntry.type} for turn ${turnId}`);
          
          set(state => {
            const newTurns = new Map(state.conversationTurns);
            const turns = newTurns.get(conversationId) || [];
            
            const updatedTurns = turns.map(turn => {
              if (turn.id === turnId) {
                const currentTrace = turn.trace || [];
                const traceExists = currentTrace.some(t => t.id === traceEntry.id);
                
                if (!traceExists) {
                  console.log(`  ✅ Adding trace #${currentTrace.length + 1} to turn`);
                  return {
                    ...turn,
                    trace: [...currentTrace, traceEntry]
                  };
                }
              }
              return turn;
            });
            
            newTurns.set(conversationId, updatedTurns);
            
            return { 
              conversationTurns: newTurns,
              updateVersion: state.updateVersion + 1
            };
          });
          
          // Log trace types for visibility in event log
          if (traceEntry.type === 'thought') {
            addEvent(`💭 Agent thinking: ${traceEntry.content.substring(0, 50)}...`);
          } else if (traceEntry.type === 'tool_call') {
            addEvent(`🔧 Tool called: ${traceEntry.toolName}`);
          } else if (traceEntry.type === 'tool_result') {
            addEvent(`✅ Tool result received`);
          }
        }
        break;
        
      case 'agent_thinking':
        // Create or update turn if it doesn't exist
        if (event.data.turnId && event.data.agentId) {
          console.log('Agent thinking event for turn:', event.data.turnId);
          
          set(state => {
            const newTurns = new Map(state.conversationTurns);
            const turns = newTurns.get(conversationId) || [];
            
            // Check if turn exists
            const turnExists = turns.some(t => t.id === event.data.turnId);
            
            if (!turnExists) {
              console.log('Creating turn from agent_thinking event');
              // Create a new turn
              const newTurn: ConversationTurn = {
                id: event.data.turnId,
                conversationId: conversationId,
                agentId: event.data.agentId,
                timestamp: new Date(),
                content: '',
                status: 'in_progress',
                startedAt: new Date(),
                trace: []
              };
              
              turns.push(newTurn);
              newTurns.set(conversationId, [...turns]);
              
              // No need to expand - traces show by default now
              
              return { 
                conversationTurns: new Map(newTurns),
                updateVersion: state.updateVersion + 1
              };
            }
            
            return state;
          });
        }
        addEvent(`💭 Agent ${event.data.agentId} is thinking...`);
        break;
        
      case 'tool_executing':
        // Similar to agent_thinking, ensure turn exists
        if (event.data.turnId && event.data.toolName) {
          console.log('Tool executing event for turn:', event.data.turnId);
          
          set(state => {
            const newTurns = new Map(state.conversationTurns);
            const turns = newTurns.get(conversationId) || [];
            
            // Check if turn exists
            const turnExists = turns.some(t => t.id === event.data.turnId);
            
            if (!turnExists && event.data.agentId) {
              console.log('Creating turn from tool_executing event');
              // Create a new turn
              const newTurn: ConversationTurn = {
                id: event.data.turnId,
                conversationId: conversationId,
                agentId: event.data.agentId,
                timestamp: new Date(),
                content: '',
                status: 'in_progress',
                startedAt: new Date(),
                trace: []
              };
              
              turns.push(newTurn);
              newTurns.set(conversationId, [...turns]);
              
              // No need to expand - traces show by default now
              
              return { 
                conversationTurns: new Map(newTurns),
                updateVersion: state.updateVersion + 1
              };
            }
            
            return state;
          });
          
          addEvent(`🔧 Executing tool: ${event.data.toolName}`);
        }
        break;
    }
  },

  addEvent: (message: string, type: 'info' | 'error' = 'info') => {
    const event: EventLogEntry = {
      id: (nextEventId++).toString(),
      timestamp: new Date(),
      message,
      type
    };
    
    set(state => ({
      events: [...state.events.slice(-99), event],
      totalEvents: state.totalEvents + 1
    }));
  },

  clearEvents: () => {
    set({ events: [], totalEvents: 0 });
  },

  setActiveTab: (tabId: string) => {
    set({ activeTab: tabId });
  },

  toggleTrace: (turnId: string) => {
    set(state => {
      const newExpanded = new Set(state.expandedTraces);
      if (newExpanded.has(turnId)) {
        newExpanded.delete(turnId);
      } else {
        newExpanded.add(turnId);
      }
      return { expandedTraces: newExpanded };
    });
  },

  toggleConversation: (conversationId: string) => {
    set(state => {
      const newExpanded = new Set(state.expandedConversations);
      if (newExpanded.has(conversationId)) {
        newExpanded.delete(conversationId);
      } else {
        newExpanded.add(conversationId);
      }
      return { expandedConversations: newExpanded };
    });
  },

  setEventFilter: (filter: string) => {
    set({ eventFilter: filter });
  }
}));

export const useConversationStore = conversationStore;