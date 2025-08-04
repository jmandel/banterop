import React, { useMemo } from 'react';
import { useConversationStore } from '../stores/conversation.store.js';
import { ConversationTurnComponent } from './ConversationTurn.js';
import { ConversationTurn } from '$lib/types.js';

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

  const exportToMarkdown = async () => {
    const conversation = conversations.get(activeTab);
    if (!conversation || turns.length === 0) return;

    let markdown = `# Conversation: ${conversation.metadata?.conversationTitle || 'Untitled'}\n\n`;
    markdown += `**ID:** ${activeTab}\n`;
    markdown += `**Agents:** ${conversation.agents?.map(a => a.id).join(', ') || 'Unknown'}\n`;
    markdown += `**Status:** ${conversation.status}\n`;
    markdown += `**Created:** ${new Date(conversation.createdAt).toLocaleString()}\n\n`;
    markdown += `---\n\n`;

    // Export each turn with its trace
    for (const turn of turns) {
      markdown += `## ${turn.agentId} - ${new Date(turn.timestamp).toLocaleString()}\n\n`;
      
      // Add trace if available
      if (turn.trace && turn.trace.length > 0) {
        markdown += `<details>\n<summary>🔍 Trace (${turn.trace.length} entries)</summary>\n\n`;
        
        for (const entry of turn.trace) {
          switch (entry.type) {
            case 'thought':
              markdown += `### 💭 Thought\n${entry.content}\n\n`;
              break;
            case 'tool_call':
              markdown += `### 🔧 Tool Call: ${entry.toolName}\n`;
              markdown += '```json\n' + JSON.stringify(entry.parameters, null, 2) + '\n```\n\n';
              break;
            case 'tool_result':
              markdown += `### ✅ Tool Result\n`;
              if (entry.error) {
                markdown += `**Error:** ${entry.error}\n\n`;
              } else if (entry.result?.content && entry.result?.contentType === 'text/markdown') {
                markdown += entry.result.content + '\n\n';
              } else {
                markdown += '```json\n' + JSON.stringify(entry.result, null, 2) + '\n```\n\n';
              }
              break;
          }
        }
        
        markdown += `</details>\n\n`;
      }
      
      // Add the actual message content
      markdown += turn.content + '\n\n';
      
      // Add attachments if any
      if (turn.attachments && turn.attachments.length > 0) {
        markdown += `**Attachments:** ${turn.attachments.length} file(s)\n\n`;
      }
      
      markdown += `---\n\n`;
    }

    // Create blob with UTF-8 encoding and open in new tab
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    
    // Open in new tab
    window.open(url, '_blank');
    
    // Clean up the URL after a delay to ensure the new tab has loaded
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  };
  
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
        <div className="header-content">
          <h2>{conversation.metadata?.conversationTitle || 'Untitled'}</h2>
          <button className="export-button" onClick={exportToMarkdown}>
            📄 Export Markdown
          </button>
        </div>
        <div className="conversation-info">
          <div>ID: {activeTab}</div>
          <div>Agents: {conversation.agents?.map(a => a.id).join(', ') || 'Loading...'}</div>
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
                  <h5>[{id.slice(0, 8)}...] {conv.agents.map(a => a.id).join(' + ')}</h5>
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