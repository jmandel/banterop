import React, { useMemo } from 'react';
import { useConversationStore } from '../stores/conversation.store.js';
import { ConversationTurnComponent } from './ConversationTurn.js';

export const ConversationView: React.FC = () => {
  const conversations = useConversationStore(state => state.conversations);
  const activeTab = useConversationStore(state => state.activeTab);
  const updateVersion = useConversationStore(state => state.updateVersion);
  
  // Get the entire conversationTurns map to trigger re-renders on any change
  const conversationTurns = useConversationStore(state => state.conversationTurns);
  
  // Use useMemo to get turns for active tab
  const turns = useMemo(() => {
    return conversationTurns.get(activeTab) || [];
  }, [conversationTurns, activeTab]);
  
  // Simple logging without causing re-renders
  React.useEffect(() => {
    console.log(`ConversationView render - ${turns.length} turns for ${activeTab}`);
  }, [turns.length, activeTab]);
  
  if (activeTab === '*') {
    return <GlobalMonitorView />;
  }
  
  const conversation = conversations.get(activeTab);
  
  if (!conversation) {
    return (
      <div className="conversation-view-empty">
        <h2>Loading Conversation...</h2>
        <p>Fetching conversation details</p>
      </div>
    );
  }
  
  return (
    <div className="conversation-view">
      <div className="conversation-header">
        <h2>{conversation.name}</h2>
        <div className="conversation-info">
          <div>ID: {activeTab}</div>
          <div>Agents: {conversation.agents?.join(', ') || 'Loading...'}</div>
          <div>Status: {conversation.status}</div>
        </div>
      </div>
      
      <div className="messages-container">
        {turns.length === 0 ? (
          <div className="no-messages">No messages yet</div>
        ) : (
          turns.map(turn => (
            <ConversationTurnComponent
              key={turn.id}
              turn={turn}
              conversationId={activeTab}
            />
          ))
        )}
      </div>
    </div>
  );
};

const GlobalMonitorView: React.FC = () => {
  const conversations = useConversationStore(state => state.conversations);
  const conversationTurns = useConversationStore(state => state.conversationTurns);
  const setActiveTab = useConversationStore(state => state.setActiveTab);
  const updateVersion = useConversationStore(state => state.updateVersion);
  
  return (
    <div className="global-monitor">
      <div className="conversation-header">
        <h2>Global Conversation Monitor</h2>
        <div className="monitor-info">
          <div>Monitoring all conversations in real-time</div>
          <div className="monitor-hint">
            Individual conversation tabs will appear automatically when agents join
          </div>
        </div>
      </div>
      
      <div className="messages-container">
        {conversations.size === 0 ? (
          <div className="empty-state">
            <h3>🌐 Waiting for Conversations</h3>
            <p>
              Run <code>bun run multi-agent-demo.ts</code> to start a multi-agent 
              conversation and see tabs appear automatically.
            </p>
            <p className="hint">Events are logged in the bottom panel.</p>
          </div>
        ) : (
          <div className="conversation-grid">
            <h4>Active Conversations ({conversations.size})</h4>
            {Array.from(conversations.entries()).map(([id, conv]) => {
              const turns = conversationTurns.get(id) || [];
              const lastActivity = turns.length > 0 
                ? new Date(turns[turns.length - 1].timestamp).toLocaleTimeString()
                : 'No activity';
                
              return (
                <div 
                  key={id} 
                  className="conversation-card" 
                  onClick={() => setActiveTab(id)}
                >
                  <h5>[{id.slice(0, 8)}...] {conv.agents.join(' + ')}</h5>
                  <p>{turns.length} turns • Last: {lastActivity}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};