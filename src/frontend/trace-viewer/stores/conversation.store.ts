import { create } from 'zustand';
import type { WebSocketJsonRpcClient } from '$client/impl/websocket.client.js';
import type { ConversationEvent, ConversationTurn, TraceEntry, SpecificConversationEvent } from '$lib/types.js';
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
  handleEvent: (event: SpecificConversationEvent, conversationId: string) => void;
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

  handleEvent: (event: SpecificConversationEvent, subscriptionId: string) => {
    const conversationId = event.conversationId;
    if (!conversationId) return;
    
    // Log event order to understand the flow
    const eventData: any = {
      conversationId: conversationId.slice(0, 8),
      data: event.data
    };
    
    // Extract common fields based on event type
    if (event.type === 'turn_started' || event.type === 'turn_completed') {
      eventData.turnId = event.data.turn.id;
      eventData.agentId = event.data.turn.agentId;
    } else if (event.type === 'trace_added') {
      eventData.turnId = event.data.turn.id;
      eventData.hasTrace = true;
    } else if (event.type === 'agent_thinking' || event.type === 'tool_executing') {
      eventData.agentId = event.data.agentId;
    } else if (event.type === 'turn_canceled') {
      eventData.turnId = event.data.turnId;
    }
    
    console.log(`📍 EVENT: ${event.type}`, eventData);

    const { conversations, conversationTurns, addEvent } = get();
    
    // If any event has a turnId, ensure the turn exists first
    let turnId: string | undefined;
    let agentId: string | undefined;
    
    if (event.type === 'turn_canceled') {
      turnId = event.data.turnId;
    } else if (event.type === 'trace_added') {
      turnId = event.data.turn.id;
    }
    
    if (turnId && event.type !== 'turn_started' && event.type !== 'turn_completed') {
      const turns = conversationTurns.get(conversationId) || [];
      const turnExists = turns.some(t => t.id === turnId);
      
      if (!turnExists) {
        console.log(`⚠️ Turn ${turnId} doesn't exist yet, creating from ${event.type} event`);
        
        // For trace_added, we can get agentId from the turn shell
        if (event.type === 'trace_added') {
          agentId = event.data.turn.agentId;
        }
        
        if (agentId) {
          set(state => {
            const newTurns = new Map(state.conversationTurns);
            const turns = newTurns.get(conversationId) || [];
            
            const newTurn: ConversationTurn = {
              id: turnId,
              conversationId: conversationId,
              agentId: agentId,
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
        addEvent(`New conversation created: ${convData.metadata?.conversationTitle || 'Unnamed'}`);
        
        // Update the conversation name if it was previously discovered
        set(state => {
          const newConversations = new Map(state.conversations);
          const existing = newConversations.get(conversationId);
          
          if (existing && existing.metadata?.conversationTitle?.startsWith('Discovered')) {
            newConversations.set(conversationId, {
              ...existing,
              metadata: convData.metadata || { conversationTitle: `Conversation ${conversationId.slice(0, 8)}...` },
              createdAt: convData.createdAt instanceof Date ? convData.createdAt.toISOString() : convData.createdAt || existing.createdAt,
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
        const traceTurnId = event.data.turn.id;
        const traceEntry = event.data.trace;
        
        if (!traceTurnId) {
          console.log('❌ TRACE_ADDED missing turnId!', event.data);
        }
        if (!traceEntry) {
          console.log('❌ TRACE_ADDED missing trace entry!', event.data);
        }
        
        if (traceTurnId && traceEntry) {
          console.log(`🔷 TRACE_ADDED: ${traceEntry.type} for turn ${traceTurnId}`);
          
          set(state => {
            const newTurns = new Map(state.conversationTurns);
            const turns = newTurns.get(conversationId) || [];
            
            const updatedTurns = turns.map(turn => {
              if (turn.id === traceTurnId) {
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
        // Agent thinking events don't have turnId
        addEvent(`💭 Agent ${event.data.agentId} is thinking: ${event.data.thought}`);
        break;
          
        
      case 'tool_executing':
        // Tool executing events don't have turnId
        addEvent(`🔧 Executing tool: ${event.data.toolName}`);
        break;
        
      case 'user_query_created':
        addEvent(`❓ User query: ${event.data.query.question}`);
        break;
        
      case 'user_query_answered':
        addEvent(`✅ User query answered`);
        break;
        
      case 'conversation_ended':
        addEvent(`🏁 Conversation ended${event.data.reason ? `: ${event.data.reason}` : ''}`);
        set(state => {
          const newConversations = new Map(state.conversations);
          const conv = newConversations.get(conversationId);
          if (conv) {
            newConversations.set(conversationId, {
              ...conv,
              status: 'completed'
            });
          }
          return { conversations: newConversations };
        });
        break;
        
      case 'conversation_ready':
        addEvent(`✅ Conversation ready`);
        break;
        
      case 'rehydrated':
        addEvent(`📥 Conversation rehydrated`);
        // Update conversation data from rehydration
        set(state => {
          const newConversations = new Map(state.conversations);
          newConversations.set(conversationId, {
            id: event.data.conversation.id,
            createdAt: event.data.conversation.createdAt instanceof Date 
              ? event.data.conversation.createdAt.toISOString() 
              : event.data.conversation.createdAt,
            status: event.data.conversation.status,
            agents: event.data.conversation.agents,
            metadata: event.data.conversation.metadata
          });
          return { conversations: newConversations };
        });
        break;
        
      case 'turn_canceled':
        addEvent(`❌ Turn canceled: ${event.data.turnId}`);
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