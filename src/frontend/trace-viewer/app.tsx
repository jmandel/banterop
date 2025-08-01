import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { WebSocketJsonRpcClient } from '$client/impl/websocket.client.js';
import type { 
  ConversationEvent, 
  ConversationTurn, 
  TraceEntry 
} from '$lib/types.js';

// ============= Types =============

// JsonRpcStats removed - the universal client doesn't expose internal stats

// ConversationTurn and TraceEntry are now imported from shared types

interface EventLogEntry {
  id: string;
  timestamp: Date;
  message: string;
  type: 'info' | 'error';
}

// Custom BrowserJsonRpcClient removed - now using universal WebSocketJsonRpcClient

// ============= Components =============

const ConnectionStatus: React.FC<{ connected: boolean }> = ({ connected }) => (
  <div className={`connection-status ${connected ? 'connected' : ''}`}>
    <div className="indicator"></div>
    <span>{connected ? 'Connected' : 'Disconnected'}</span>
  </div>
);

const StatCard: React.FC<{ value: number; label: string }> = ({ value, label }) => (
  <div className="stat-card">
    <div className="stat-value">{value}</div>
    <div className="stat-label">{label}</div>
  </div>
);

// JsonRpcStats component removed - stats not available from universal client

const EventLog: React.FC<{ 
  events: EventLogEntry[];
  onClear: () => void;
  minimized: boolean;
  onToggleMinimize: () => void;
}> = ({ events, onClear, minimized, onToggleMinimize }) => (
  <div className={`event-log ${minimized ? 'minimized' : ''}`}>
    <div className="event-log-header">
      <span>Event Log</span>
      <div>
        <button onClick={onToggleMinimize} className="clear-btn" style={{ marginRight: '0.5rem' }}>
          {minimized ? '▲' : '▼'}
        </button>
        <button onClick={onClear} className="clear-btn">Clear</button>
      </div>
    </div>
    {!minimized && (
      <div className="event-log-content">
        {events.map(event => (
          <div key={event.id} className={`event-log-entry ${event.type}`}>
            [{event.timestamp.toLocaleTimeString()}] {event.message}
          </div>
        ))}
      </div>
    )}
  </div>
);

const TraceEntryComponent: React.FC<{ entry: TraceEntry }> = ({ entry }) => {
  const icons: Record<string, string> = {
    thought: '💭',
    tool_call: '🔧',
    tool_result: '✅',
    user_query: '❓',
    user_response: '💬'
  };

  let content = '';
  switch (entry.type) {
    case 'thought':
      content = entry.content;
      break;
    case 'tool_call':
      content = `Called ${entry.toolName}`;
      break;
    case 'tool_result':
      content = entry.error || 'Success';
      break;
    case 'user_query':
      content = `User query: ${entry.question}`;
      break;
    case 'user_response':
      content = `User response: ${entry.response}`;
      break;
  }

  return (
    <div className={`trace-entry ${entry.type}`}>
      {icons[entry.type] || '•'} {content}
    </div>
  );
};

const ConversationTurnComponent: React.FC<{
  turn: ConversationTurn;
  onToggleTrace: (turnId: string) => void;
  showTrace: boolean;
  conversationDetails?: any;
  isGlobalMode?: boolean;
  onToggleConversationDetails?: (conversationId: string) => void;
  showConversationDetails?: boolean;
}> = ({ 
  turn, 
  onToggleTrace, 
  showTrace, 
  conversationDetails, 
  isGlobalMode = false,
  onToggleConversationDetails,
  showConversationDetails = false
}) => {
  // Extract conversation ID from turn (for global mode)
  const conversationId = isGlobalMode ? (turn as any).conversationId : null;
  const shortId = conversationId?.slice(0, 8);
  
  return (
    <div className={`turn ${turn.status === 'in_progress' ? 'in-progress' : ''}`}>
      <div className="turn-header">
        <span className="turn-agent">{turn.agentId}</span>
        <span className="turn-time">{
          turn.timestamp instanceof Date 
            ? turn.timestamp.toLocaleTimeString()
            : new Date(turn.timestamp).toLocaleTimeString()
        }</span>
        {isGlobalMode && conversationId && (
          <span className="conversation-badge" onClick={() => onToggleConversationDetails?.(conversationId)}>
            [{shortId}...] {showConversationDetails ? '▼' : '▶'}
          </span>
        )}
        {turn.status === 'in_progress' && <span className="typing-indicator">processing...</span>}
      </div>
      
      {isGlobalMode && showConversationDetails && conversationDetails && (
        <div className="conversation-details">
          <div><strong>Conversation:</strong> {conversationId}</div>
          {conversationDetails.agents && (
            <div><strong>Agents:</strong> {conversationDetails.agents.join(', ')}</div>
          )}
        </div>
      )}
      
      <div className="turn-content">
        {turn.status === 'in_progress' ? (
          <div style={{ fontStyle: 'italic', color: '#888' }}>Processing...</div>
        ) : (
          turn.content
        )}
      </div>
      {turn.trace && turn.trace.length > 0 && (
        <>
          <div className="trace-toggle" onClick={() => onToggleTrace(turn.id)}>
            <span>{showTrace ? '▼' : '▶'}</span>
            View trace ({turn.trace.length} entries)
          </div>
          <div className={`trace-entries ${showTrace ? 'show' : ''}`}>
            {turn.trace.map(entry => (
              <TraceEntryComponent key={entry.id} entry={entry} />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// ============= Main App Component =============

const TraceViewer: React.FC = () => {
  const [connected, setConnected] = useState(false);
  const [client, setClient] = useState<WebSocketJsonRpcClient | null>(null);
  const [wsEndpoint, setWsEndpoint] = useState(() => {
    return localStorage.getItem('trace-viewer-ws-endpoint') || 'ws://localhost:3001/api/ws';
  });
  const [apiEndpoint, setApiEndpoint] = useState(() => {
    return localStorage.getItem('trace-viewer-api-endpoint') || 'http://localhost:3001/api';
  });
  // Stats removed - not available in universal client
  const [eventFilter, setEventFilter] = useState('');
  const [conversationIdInput, setConversationIdInput] = useState('');
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [activeConversations, setActiveConversations] = useState<Map<string, any>>(new Map());
  const [conversationTurns, setConversationTurns] = useState<Map<string, ConversationTurn[]>>(new Map());
  const [conversationSubscriptions, setConversationSubscriptions] = useState<Map<string, string>>(new Map());
  const [activeTab, setActiveTab] = useState<string>('*'); // Start with global monitoring
  const [inProgressTurns, setInProgressTurns] = useState<Map<string, any>>(new Map());
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set());
  const [expandedConversations, setExpandedConversations] = useState<Set<string>>(new Set());
  const [totalMessages, setTotalMessages] = useState(0);
  const [totalEvents, setTotalEvents] = useState(0);
  const [conversationDetails, setConversationDetails] = useState<Map<string, any>>(new Map());
  const [eventLogMinimized, setEventLogMinimized] = useState(false);

  const nextEventId = useRef(0);

  // Auto-connect on component mount
  useEffect(() => {
    handleConnect();
  }, []);

  const addEvent = (message: string, type: 'info' | 'error' = 'info') => {
    const event: EventLogEntry = {
      id: (nextEventId.current++).toString(),
      timestamp: new Date(),
      message,
      type
    };
    setEvents(prev => [...prev.slice(-99), event]); // Keep last 100 events
    setTotalEvents(prev => prev + 1);
  };

  const clearEvents = () => {
    setEvents([]);
    setTotalEvents(0);
  };

  const loadConversations = async (clientToUse?: WebSocketJsonRpcClient) => {
    const activeClient = clientToUse || client;
    if (!activeClient) {
      addEvent('Not connected - cannot load conversations', 'error');
      return;
    }

    try {
      console.log('Fetching conversations from API...');
      // First, get the list of recent conversations
      const result = await activeClient.getAllConversations({ 
        limit: 10, 
        includeTurns: false, 
        includeTrace: false 
      });
      
      console.log('API response:', result);
      const conversations = result.conversations || [];
      console.log('Parsed conversations:', conversations);
      setConversations(conversations);
      
      // Auto-create tabs for all fetched conversations and load full details
      console.log(`Creating tabs for ${conversations.length} conversations`);
      const newActiveConversations = new Map();
      const newConversationTurns = new Map();
      const newConversationDetails = new Map();
      
      for (const conv of conversations) {
        console.log('Processing conversation:', conv.id, conv.name);
        
        // Add basic tab info first
        newActiveConversations.set(conv.id, {
          id: conv.id,
          name: conv.name || `Conversation ${conv.id.slice(0, 8)}...`,
          createdAt: conv.createdAt,
          status: conv.status
        });
        
        // Load full conversation details with turns and traces
        try {
          console.log(`Loading full details for conversation ${conv.id}...`);
          const fullConv = await activeClient.getConversation(conv.id, {
            includeTurns: true,
            includeTrace: true
          });
          
          if (fullConv) {
            // Update tab with full metadata
            newActiveConversations.set(conv.id, fullConv);
            
            // Load turns with traces
            if (fullConv.turns && fullConv.turns.length > 0) {
              const turns = fullConv.turns.map(turn => ({
                id: turn.id,
                agentId: turn.agentId,
                timestamp: turn.timestamp,
                content: turn.content || '',
                status: turn.status || 'completed' as const,
                trace: turn.trace || []
              }));
              newConversationTurns.set(conv.id, turns);
              console.log(`Loaded ${turns.length} turns for conversation ${conv.id}`);
            }
            
            // Load conversation details (agents, etc.)
            newConversationDetails.set(conv.id, {
              id: conv.id,
              agents: fullConv.agents?.map(agent => typeof agent === 'string' ? agent : agent.id) || [],
              status: fullConv.status
            });
          }
        } catch (error) {
          console.error(`Failed to load full details for conversation ${conv.id}:`, error);
          addEvent(`Failed to load full details for conversation ${conv.id.slice(0, 8)}...`, 'error');
          
          // Keep basic conversation info even if full load fails
          newConversationDetails.set(conv.id, {
            id: conv.id,
            agents: conv.agents?.map(agent => typeof agent === 'string' ? agent : agent.id) || [],
            status: conv.status
          });
        }
      }
      
      // Update all the state maps
      console.log('Setting state - activeConversations:', newActiveConversations);
      console.log('Setting state - conversationTurns:', newConversationTurns);
      console.log('Setting state - conversationDetails:', newConversationDetails);
      
      setActiveConversations(newActiveConversations);
      setConversationTurns(newConversationTurns);
      setConversationDetails(newConversationDetails);
      
      addEvent(`Loaded ${conversations.length} recent conversations with full turns and traces`);
      
      if (conversations.length > 0) {
        addEvent(`Created tabs for ${conversations.length} conversations with complete history`);
      }
    } catch (error) {
      addEvent('Failed to load conversations: ' + (error as Error).message, 'error');
      setConversations([]);
    }
  };

  const handleConnect = async () => {
    try {
      const newClient = new WebSocketJsonRpcClient(wsEndpoint);
      
      // Set up event handlers using the universal client's EventEmitter API
      newClient.on('error', (error: Error) => {
        addEvent(`WebSocket error: ${error.message}`, 'error');
      });

      let globalSubscriptionId: string | null = null;

      await newClient.connect();
      setClient(newClient);
      setConnected(true);
      addEvent('Connected to WebSocket server');
      
      // Load conversations after connecting
      await loadConversations(newClient);
      
      addEvent('Connected in read-only mode - no authentication required for viewing events');
      
      // Auto-select "Monitor All Conversations" mode by storing the handler reference
      globalSubscriptionId = await startGlobalMonitoring(newClient);
      
      // Update the event handler with the correct subscription ID
      newClient.removeAllListeners('event'); // Clear previous listeners
      newClient.on('event', (event: ConversationEvent, subId: string) => {
        if (globalSubscriptionId && subId === globalSubscriptionId) {
          handleGlobalConversationEvent(event);
        }
      });
    } catch (error) {
      addEvent('Failed to connect: ' + (error as Error).message, 'error');
    }
  };

  const handleDisconnect = async () => {
    // Unsubscribe from all active subscriptions
    if (client) {
      for (const subscriptionId of conversationSubscriptions.values()) {
        try {
          await client.unsubscribe(subscriptionId);
        } catch (error) {
          // Ignore errors during cleanup
        }
      }
    }
    
    if (client) {
      client.disconnect();
      setClient(null);
    }
    
    setActiveTab('*');
    setConversationTurns(new Map());
    setActiveConversations(new Map());
    setConversationSubscriptions(new Map());
    setConnected(false);
  };

  const startGlobalMonitoring = async (clientToUse?: WebSocketJsonRpcClient) => {
    const activeClient = clientToUse || client;
    if (!activeClient) {
      addEvent('Not connected', 'error');
      return;
    }

    try {
      setActiveTab('*');
      
      // Subscribe to global events
      const options = eventFilter ? { events: eventFilter.split(',') } : undefined;
      const subscriptionId = await activeClient.subscribe('*', options);
      
      
      // Store the global subscription
      setConversationSubscriptions(prev => {
        const newMap = new Map(prev);
        newMap.set('*', subscriptionId);
        return newMap;
      });
      
      addEvent('Monitoring all conversations - tabs will appear automatically');
      return subscriptionId;
    } catch (error) {
      addEvent('Failed to start global monitoring: ' + (error as Error).message, 'error');
      return null;
    }
  };

  const switchToTab = (conversationId: string) => {
    setActiveTab(conversationId);
  };

  const loadSpecificConversation = async (conversationId: string) => {
    if (!client) return;

    try {
      // Get conversation details if not already loaded
      if (!activeConversations.has(conversationId)) {
        const conversation = await client.getConversation(conversationId, {
          includeTurns: true,
          includeTrace: true,
          includeInProgress: true
        });

        setActiveConversations(prev => {
          const newMap = new Map(prev);
          newMap.set(conversationId, conversation);
          return newMap;
        });

        setConversationTurns(prev => {
          const newMap = new Map(prev);
          newMap.set(conversationId, conversation.turns || []);
          return newMap;
        });

        addEvent(`Loaded conversation ${conversationId.slice(0, 8)}...`);
      }
      
      switchToTab(conversationId);
    } catch (error) {
      addEvent('Failed to load conversation: ' + (error as Error).message, 'error');
    }
  };


  const handleGlobalConversationEvent = (event: ConversationEvent) => {
    addEvent(`Global Event: ${event.type} (Conversation: ${event.conversationId?.slice(0, 8)}...)`);
    
    const conversationId = event.conversationId;
    if (!conversationId) return;

    // Idempotent Discovery and Backfill Logic
    if (!activeConversations.has(conversationId)) {
      
      // This block executes ONLY ONCE for each new conversation.
      // The `activeConversations` map acts as a synchronous lock.
      
      // 1. Create an immediate placeholder tab.
      setActiveConversations(prev => {
        const newMap = new Map(prev);
        newMap.set(conversationId, {
          id: conversationId,
          name: `Discovered ${conversationId.slice(0, 8)}...`,
          status: 'active',
          createdAt: new Date().toISOString(),
          agents: [],
        });
        return newMap;
      });

      // 2. Asynchronously backfill the full conversation history.
      const backfillHistory = async () => {
        try {
          if (!client) return;
          // Fetch everything: metadata, turns, and their traces.
          const fullHistory = await client.getConversation(conversationId, {
            includeTurns: true,
            includeTrace: true 
          });

          if (fullHistory) {
            // Update tab with full metadata.
            setActiveConversations(prev => {
              const newMap = new Map(prev);
              newMap.set(conversationId, fullHistory);
              return newMap;
            });
            // Populate the turns list with the historical data.
            setConversationTurns(prev => {
              const newMap = new Map(prev);
              newMap.set(conversationId, fullHistory.turns || []);
              return newMap;
            });
            // Update conversation details
            setConversationDetails(prev => {
              const newMap = new Map(prev);
              newMap.set(conversationId, {
                id: conversationId,
                agents: fullHistory.agents?.map(agent => typeof agent === 'string' ? agent : agent.id) || [],
                status: fullHistory.status
              });
              return newMap;
            });
          }
        } catch (error) {
          addEvent(`Failed to backfill history for ${conversationId}`, 'error');
        }
      };
      
      backfillHistory();
    }

    // Logic to process the current, live event. This runs for every event.
    switch (event.type) {
      case 'conversation_created':
        // This event is emitted for ALL conversations (internal & external) right after creation
        const convData = event.data.conversation;
        addEvent(`New ${convData.managementMode} conversation created: ${convData.name || 'Unnamed'} (${conversationId.slice(0, 8)}...)`);
        break;
        
      case 'conversation_ready':
        // This event is emitted only for internal conversations after agent provisioning
        addEvent(`Conversation ${conversationId.slice(0, 8)}... is ready with all agents provisioned`);
        break;
        
      case 'turn_completed':
        if (event.data.turn) {
          setConversationTurns(prev => {
            const newMap = new Map(prev);
            const turns = newMap.get(conversationId) || [];
            const turnExists = turns.some(t => t.id === event.data.turn.id);
            // Add or update the turn to handle both new turns and updates to in-progress ones.
            const updatedTurns = turnExists 
              ? turns.map(t => t.id === event.data.turn.id ? event.data.turn : t)
              : [...turns, event.data.turn];
            newMap.set(conversationId, updatedTurns);
            return newMap;
          });
          setTotalMessages(prev => prev + 1);
        }
        break;
        
      case 'turn_started':
        if (event.data.turn) {
          setConversationTurns(prev => {
            const newMap = new Map(prev);
            const turns = newMap.get(conversationId) || [];
            const turnExists = turns.some(t => t.id === event.data.turn.id);
            // Add or update the turn to handle both new turns and updates to in-progress ones.
            const updatedTurns = turnExists 
              ? turns.map(t => t.id === event.data.turn.id ? event.data.turn : t)
              : [...turns, event.data.turn];
            newMap.set(conversationId, updatedTurns);
            return newMap;
          });
        }
        break;
    }
  };




  const toggleTrace = (turnId: string) => {
    setExpandedTraces(prev => {
      const newSet = new Set(prev);
      if (newSet.has(turnId)) {
        newSet.delete(turnId);
      } else {
        newSet.add(turnId);
      }
      return newSet;
    });
  };

  const toggleConversationDetails = (conversationId: string) => {
    setExpandedConversations(prev => {
      const newSet = new Set(prev);
      if (newSet.has(conversationId)) {
        newSet.delete(conversationId);
      } else {
        newSet.add(conversationId);
      }
      return newSet;
    });
  };

  return (
    <>
      <div className="header">
        <h1>Agent Conversation Monitor</h1>
        <ConnectionStatus connected={connected} />
      </div>

      <div className="main-container">
        <div className="sidebar">
          <div className="controls">
            <input
              type="text"
              value={wsEndpoint}
              onChange={(e) => {
                const value = e.target.value;
                setWsEndpoint(value);
                localStorage.setItem('trace-viewer-ws-endpoint', value);
              }}
              placeholder="WebSocket Endpoint"
            />
            <input
              type="text"
              value={apiEndpoint}
              onChange={(e) => {
                const value = e.target.value;
                setApiEndpoint(value);
                localStorage.setItem('trace-viewer-api-endpoint', value);
              }}
              placeholder="REST API Endpoint"
            />
            <button onClick={handleConnect} disabled={connected}>
              Connect
            </button>
            <button onClick={handleDisconnect} disabled={!connected}>
              Disconnect
            </button>
            
            <select
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              style={{ marginTop: '1rem' }}
            >
              <option value="">All Events</option>
              <option value="turn_completed">Completed Turns Only</option>
              <option value="turn_started,agent_thinking,tool_executing">Processing Events</option>
              <option value="turn_started,turn_completed">Turn Lifecycle</option>
            </select>
            
            <input
              type="text"
              value={conversationIdInput}
              onChange={(e) => setConversationIdInput(e.target.value)}
              placeholder="Enter conversation ID manually..."
              style={{ marginTop: '1rem' }}
            />
            <button
              onClick={() => conversationIdInput && loadSpecificConversation(conversationIdInput)}
              disabled={!connected || !conversationIdInput}
              style={{ marginTop: '0.5rem' }}
            >
              Load Conversation
            </button>
          </div>

          <div className="stats-grid">
            <StatCard value={totalMessages} label="Messages" />
            <StatCard value={totalEvents} label="Events" />
          </div>

          {/* JsonRpcStats removed - not available in universal client */}

          <div className="conversations-section">
            <h2 style={{ margin: '1rem 0', fontSize: '1.125rem' }}>Conversations</h2>
            
            <ul className="conversation-list">
              {conversations.map(conv => (
                <li
                  key={conv.id}
                  className={`conversation-item ${activeTab === conv.id ? 'active' : ''}`}
                  onClick={() => switchToTab(conv.id)}
                >
                  <h3>{conv.name}</h3>
                  <div style={{ fontSize: '0.875rem', color: '#666' }}>
                    {new Date(conv.createdAt).toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="conversation-view">
          {/* Tab Bar */}
          <div className="tab-bar">
            <div 
              className={`tab ${activeTab === '*' ? 'active' : ''}`}
              onClick={() => switchToTab('*')}
            >
              🌐 All Conversations
            </div>
            {Array.from(activeConversations.entries()).map(([id, conversation]) => {
              const shortId = id.slice(0, 8);
              const agents = conversationDetails.get(id)?.agents || [];
              return (
                <div 
                  key={id}
                  className={`tab ${activeTab === id ? 'active' : ''}`}
                  onClick={() => switchToTab(id)}
                  title={`${id}\nAgents: ${agents.join(', ')}`}
                >
                  [{shortId}...] {agents.length > 0 ? agents.join(' + ') : 'Loading...'}
                </div>
              );
            })}
          </div>

          {/* Tab Content */}
          <div className="tab-content">
            {activeTab === '*' ? (
              <div className="global-monitor">
                <div className="conversation-header">
                  <h2>Global Conversation Monitor</h2>
                  <div style={{ marginTop: '0.5rem', color: '#666' }}>
                    <div>Monitoring all conversations in real-time</div>
                    <div style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
                      Individual conversation tabs will appear automatically when agents join
                    </div>
                  </div>
                </div>
                <div className="messages-container">
                  {activeConversations.size === 0 ? (
                    <div style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center', 
                      height: '50%', 
                      color: '#888',
                      flexDirection: 'column',
                      textAlign: 'center'
                    }}>
                      <h3>🌐 Waiting for Conversations</h3>
                      <p style={{ marginTop: '1rem', maxWidth: '400px' }}>
                        Run <code style={{ background: '#2a2a2a', padding: '0.25rem', borderRadius: '4px' }}>
                          bun run multi-agent-demo.ts
                        </code> to start a multi-agent conversation and see tabs appear automatically.
                      </p>
                      <p style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}>
                        Events are logged in the bottom-right corner.
                      </p>
                    </div>
                  ) : (
                    <div style={{ padding: '1rem' }}>
                      <h4>Active Conversations ({activeConversations.size})</h4>
                      {Array.from(activeConversations.entries()).map(([id, conversation]) => {
                        const agents = conversationDetails.get(id)?.agents || [];
                        const turns = conversationTurns.get(id) || [];
                        return (
                          <div key={id} className="conversation-summary" onClick={() => switchToTab(id)}>
                            <h5>[{id.slice(0, 8)}...] {agents.join(' + ')}</h5>
                            <p>{turns.length} turns • Last activity: {turns.length > 0 ? new Date(turns[turns.length - 1].timestamp).toLocaleTimeString() : 'No activity'}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="conversation-tab">
                {activeConversations.has(activeTab) ? (
                  <>
                    <div className="conversation-header">
                      <h2>{activeConversations.get(activeTab)?.name || `Conversation ${activeTab.slice(0, 8)}...`}</h2>
                      <div style={{ marginTop: '0.5rem', color: '#666' }}>
                        <div>ID: {activeTab}</div>
                        <div>Agents: {conversationDetails.get(activeTab)?.agents?.join(', ') || 'Loading...'}</div>
                      </div>
                    </div>
                    <div className="messages-container">
                      {(conversationTurns.get(activeTab) || []).map(turn => (
                        <ConversationTurnComponent
                          key={turn.id}
                          turn={turn}
                          onToggleTrace={toggleTrace}
                          showTrace={expandedTraces.has(turn.id)}
                          isGlobalMode={false}
                        />
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666' }}>
                    <div style={{ textAlign: 'center' }}>
                      <h2>Loading Conversation...</h2>
                      <p style={{ marginTop: '1rem' }}>Fetching conversation details</p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <EventLog 
        events={events} 
        onClear={clearEvents} 
        minimized={eventLogMinimized}
        onToggleMinimize={() => setEventLogMinimized(!eventLogMinimized)}
      />

      <style>{`
        .header {
          background: #1a1a1a;
          padding: 1rem 2rem;
          border-bottom: 1px solid #333;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .header h1 {
          font-size: 1.5rem;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          margin: 0;
        }

        .connection-status {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 1rem;
          background: #2a2a2a;
          border-radius: 20px;
          font-size: 0.875rem;
        }

        .connection-status .indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #ef4444;
        }

        .connection-status.connected .indicator {
          background: #4ade80;
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .main-container {
          display: flex;
          flex: 1;
          overflow: hidden;
          height: calc(100vh - 80px);
        }

        .sidebar {
          width: 350px;
          background: #1a1a1a;
          border-right: 1px solid #333;
          padding: 1rem;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .controls {
          margin-bottom: 1rem;
        }

        .controls input,
        .controls select,
        .controls button {
          width: 100%;
          margin-bottom: 0.5rem;
          padding: 0.5rem;
          background: #2a2a2a;
          border: 1px solid #444;
          border-radius: 4px;
          color: #e0e0e0;
          font-family: inherit;
        }

        .controls button {
          background: #667eea;
          border: none;
          cursor: pointer;
          transition: background 0.2s;
        }

        .controls button:hover:not(:disabled) {
          background: #5a67d8;
        }

        .controls button:disabled {
          background: #444;
          cursor: not-allowed;
        }

        .stats-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 1rem;
          margin-bottom: 1rem;
        }

        .stat-card {
          background: #2a2a2a;
          padding: 1rem;
          border-radius: 8px;
          text-align: center;
        }

        .stat-value {
          font-size: 1.5rem;
          font-weight: bold;
          color: #667eea;
        }

        .stat-label {
          font-size: 0.875rem;
          color: #888;
          margin-top: 0.25rem;
        }

        .json-rpc-status {
          margin-top: 1rem;
          padding: 1rem;
          background: #2a2a2a;
          border-radius: 8px;
          font-size: 0.875rem;
        }

        .json-rpc-status h3 {
          margin: 0 0 0.5rem 0;
        }

        .json-rpc-status .stat {
          display: flex;
          justify-content: space-between;
          margin-bottom: 0.25rem;
        }

        .conversations-section {
          flex: 1;
          overflow-y: auto;
          margin-top: 1rem;
        }

        .conversation-list {
          list-style: none;
          padding: 0;
          margin: 0;
        }

        .conversation-item {
          padding: 1rem;
          margin-bottom: 0.5rem;
          background: #2a2a2a;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s;
          border: 1px solid transparent;
        }

        .conversation-item:hover {
          border-color: #667eea;
          transform: translateX(4px);
        }

        .conversation-item.active {
          background: #3a3a3a;
          border-color: #667eea;
        }

        .conversation-item h3 {
          margin: 0 0 0.25rem 0;
        }

        .conversation-view {
          flex: 1;
          display: grid;
          grid-template-rows: auto 1fr;
          background: #0f0f0f;
          overflow: hidden;
        }

        .conversation-header {
          padding: 1.5rem;
          background: #1a1a1a;
          border-bottom: 1px solid #333;
        }

        .conversation-header h2 {
          margin: 0;
        }

        .messages-container {
          flex: 1;
          overflow-y: auto;
          padding: 2rem;
        }

        .turn {
          margin-bottom: 2rem;
          animation: fadeIn 0.3s;
        }

        .turn.in-progress {
          opacity: 0.8;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .turn-header {
          display: flex;
          align-items: center;
          gap: 1rem;
          margin-bottom: 0.5rem;
        }

        .turn-agent {
          font-weight: 600;
          color: #667eea;
        }

        .turn-time {
          font-size: 0.875rem;
          color: #666;
        }

        .typing-indicator {
          font-size: 0.875rem;
          color: #667eea;
          animation: pulse 1.5s infinite;
        }

        .turn-content {
          background: #1a1a1a;
          padding: 1rem;
          border-radius: 8px;
          border-left: 3px solid #667eea;
        }

        .trace-toggle {
          margin-top: 0.5rem;
          font-size: 0.875rem;
          color: #888;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
        }

        .trace-toggle:hover {
          color: #aaa;
        }

        .trace-entries {
          margin-top: 1rem;
          padding-left: 1rem;
          border-left: 2px solid #333;
          display: none;
        }

        .trace-entries.show {
          display: block;
        }

        .trace-entry {
          margin-bottom: 0.5rem;
          font-size: 0.875rem;
          color: #888;
          padding: 0.25rem 0;
        }

        .trace-entry.thought {
          color: #f59e0b;
        }

        .trace-entry.tool_call {
          color: #3b82f6;
        }

        .trace-entry.tool_result {
          color: #10b981;
        }

        .event-log {
          position: fixed;
          bottom: 2rem;
          right: 2rem;
          width: 400px;
          max-height: 300px;
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 8px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          z-index: 1000;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }

        .event-log.minimized {
          max-height: 60px;
        }

        .event-log-header {
          padding: 1rem;
          background: #2a2a2a;
          border-bottom: 1px solid #333;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .event-log-content {
          flex: 1;
          overflow-y: auto;
          padding: 1rem;
          font-size: 0.875rem;
          font-family: monospace;
        }

        .event-log-entry {
          margin-bottom: 0.5rem;
          opacity: 0.8;
        }

        .event-log-entry.error {
          color: #ef4444;
        }

        .clear-btn {
          padding: 0.25rem 0.5rem;
          background: #444;
          border: none;
          border-radius: 4px;
          color: #e0e0e0;
          cursor: pointer;
        }

        .clear-btn:hover {
          background: #555;
        }

        .conversation-badge {
          background: #374151;
          color: #9ca3af;
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-size: 0.75rem;
          cursor: pointer;
          transition: background 0.2s;
        }

        .conversation-badge:hover {
          background: #4b5563;
          color: #e0e0e0;
        }

        .conversation-details {
          background: #2a2a2a;
          border: 1px solid #444;
          border-radius: 4px;
          padding: 0.75rem;
          margin: 0.5rem 0;
          font-size: 0.875rem;
        }

        .conversation-details div {
          margin-bottom: 0.25rem;
        }

        .conversation-details div:last-child {
          margin-bottom: 0;
        }

        .tab-bar {
          display: flex;
          background: #1a1a1a;
          border-bottom: 1px solid #333;
          overflow-x: auto;
          white-space: nowrap;
          min-height: 48px;
          max-height: 48px;
          scrollbar-width: thin;
          scrollbar-color: #666 #1a1a1a;
        }

        .tab-bar::-webkit-scrollbar {
          height: 6px;
        }

        .tab-bar::-webkit-scrollbar-track {
          background: #1a1a1a;
        }

        .tab-bar::-webkit-scrollbar-thumb {
          background: #666;
          border-radius: 3px;
        }

        .tab {
          padding: 0.75rem 1rem;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          transition: all 0.2s;
          min-width: 120px;
          max-width: 200px;
          text-align: center;
          font-size: 0.875rem;
          color: #888;
          border-right: 1px solid #333;
          flex-shrink: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .tab:hover {
          background: #2a2a2a;
          color: #ccc;
        }

        .tab.active {
          background: #2a2a2a;
          border-bottom-color: #667eea;
          color: #e0e0e0;
        }

        .tab-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .conversation-tab,
        .global-monitor {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .conversation-summary {
          background: #2a2a2a;
          border: 1px solid #444;
          border-radius: 4px;
          padding: 1rem;
          margin-bottom: 0.5rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        .conversation-summary:hover {
          border-color: #667eea;
          transform: translateX(4px);
        }

        .conversation-summary h5 {
          margin: 0 0 0.5rem 0;
          color: #667eea;
        }

        .conversation-summary p {
          margin: 0;
          color: #888;
          font-size: 0.875rem;
        }
      `}</style>
    </>
  );
};

// ============= Bootstrap =============

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<TraceViewer />);
}