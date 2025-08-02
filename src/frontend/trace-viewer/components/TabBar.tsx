import React from 'react';
import { useConversationStore } from '../stores/conversation.store.js';

export const TabBar: React.FC = () => {
  const conversations = useConversationStore(state => state.conversations);
  const activeTab = useConversationStore(state => state.activeTab);
  const setActiveTab = useConversationStore(state => state.setActiveTab);
  
  return (
    <div className="tab-bar">
      <div 
        className={`tab ${activeTab === '*' ? 'active' : ''}`}
        onClick={() => setActiveTab('*')}
      >
        🌐 All Conversations
      </div>
      
      {Array.from(conversations.entries()).map(([id, conversation]) => {
        const shortId = id.slice(0, 8);
        const agents = conversation.agents || [];
        
        return (
          <div 
            key={id}
            className={`tab ${activeTab === id ? 'active' : ''}`}
            onClick={() => setActiveTab(id)}
            title={`${id}\nAgents: ${agents.join(', ')}`}
          >
            [{shortId}...] {agents.length > 0 ? agents.join(' + ') : 'Loading...'}
          </div>
        );
      })}
    </div>
  );
};