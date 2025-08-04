import React from 'react';
import { useConversationStore } from '../stores/conversation.store.js';

export const ConversationList: React.FC = () => {
  const conversations = useConversationStore(state => state.conversations);
  const activeTab = useConversationStore(state => state.activeTab);
  const setActiveTab = useConversationStore(state => state.setActiveTab);
  
  const sortedConversations = Array.from(conversations?.values() || []).sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  
  return (
    <div className="conversations-section">
      <h2>Recent Conversations</h2>
      
      <ul className="conversation-list">
        {sortedConversations.map(conv => (
          <li
            key={conv.id}
            className={`conversation-item ${activeTab === conv.id ? 'active' : ''}`}
            onClick={() => setActiveTab(conv.id)}
          >
            <h3>{conv.metadata?.conversationTitle || 'Untitled'}</h3>
            <div className="conversation-meta">
              <div>{new Date(conv.createdAt).toLocaleString()}</div>
              {conv.turnCount !== undefined && (
                <div>{conv.turnCount} turns</div>
              )}
              {conv.agents.length > 0 && (
                <div className="conversation-agents">
                  {conv.agents.map(agent => agent.id).join(', ')}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};