import React, { useEffect, useRef, useMemo } from 'react';
import type { ConversationTurn } from '../types/index.js';
import { TraceEntryComponent } from './TraceEntry.js';
import { useConversationStore } from '../stores/conversation.store.js';
import { useUIStore } from '../stores/ui.store.js';
import { marked } from 'marked';

interface ConversationTurnProps {
  turn: ConversationTurn;
  conversationId?: string;
}

export const ConversationTurnComponent: React.FC<ConversationTurnProps> = ({ 
  turn, 
  conversationId 
}) => {
  const expandedTraces = useConversationStore(state => state.expandedTraces);
  const toggleTrace = useConversationStore(state => state.toggleTrace);
  // Default to showing traces (true if not explicitly collapsed)
  const showTrace = !expandedTraces.has(turn.id);
  const traceEndRef = useRef<HTMLDivElement>(null);
  
  // Configure marked for safe rendering
  const renderedContent = useMemo(() => {
    if (!turn.content) return '';
    try {
      return marked.parse(turn.content, {
        gfm: true,
        breaks: true,
        sanitize: false // We'll trust the content for now
      });
    } catch (error) {
      console.error('Failed to parse markdown:', error);
      return turn.content;
    }
  }, [turn.content]);
  
  // Auto-scroll to new traces only if already at bottom
  useEffect(() => {
    if (showTrace && turn.status === 'in_progress' && traceEndRef.current) {
      // Get the scrollable container (messages-container)
      const container = traceEndRef.current.closest('.messages-container');
      if (container) {
        // Check if we're at the bottom (within 100px tolerance)
        const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
        
        if (isAtBottom) {
          traceEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    }
  }, [turn.trace?.length, showTrace, turn.status]);
  
  return (
    <div className={`turn ${turn.status === 'in_progress' ? 'in-progress' : ''}`}>
      <div className="turn-header">
        <span className="turn-agent">{turn.agentId}</span>
        <span className="turn-time">
          {turn.timestamp instanceof Date 
            ? turn.timestamp.toLocaleTimeString()
            : new Date(turn.timestamp).toLocaleTimeString()}
        </span>
        {turn.status === 'in_progress' && (
          <span className="typing-indicator">processing...</span>
        )}
      </div>
      
      <div className="turn-content">
        {turn.trace && turn.trace.length > 0 && (
          <>
            <div className="trace-toggle" onClick={() => toggleTrace(turn.id)}>
              <span>{showTrace ? '▼' : '▶'}</span>
              View trace ({turn.trace.length} entries)
              {turn.status === 'in_progress' && (
                <span style={{ color: '#667eea', marginLeft: '0.5rem' }}>• Live</span>
              )}
            </div>
            <div className={`trace-entries ${showTrace ? 'show' : ''}`}>
              {turn.trace.map(entry => (
                <TraceEntryComponent key={entry.id} entry={entry} />
              ))}
              <div ref={traceEndRef} />
            </div>
          </>
        )}
        
        {turn.status === 'in_progress' ? (
          <div style={{ fontStyle: 'italic', color: '#888' }}>
            {turn.content || 'Processing...'}
          </div>
        ) : (
          <>
            <div 
              className="turn-markdown-content"
              dangerouslySetInnerHTML={{ __html: renderedContent }}
            />
            {turn.attachments && turn.attachments.length > 0 && (
              <div className="turn-attachments">
                <div className="attachments-header">
                  <span>📎 Attachments ({turn.attachments.length})</span>
                </div>
                <div className="attachments-list">
                  {turn.attachments.map((attachmentId) => (
                    <AttachmentChip key={attachmentId} attachmentId={attachmentId} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const AttachmentChip: React.FC<{ attachmentId: string }> = ({ attachmentId }) => {
  const [metadata, setMetadata] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const apiEndpoint = useUIStore(state => state.apiEndpoint);
  
  React.useEffect(() => {
    fetch(`${apiEndpoint}/attachments/${attachmentId}`)
      .then(res => {
        console.log(`Attachment ${attachmentId} response:`, res.status, res.statusText);
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        console.log(`Attachment ${attachmentId} data:`, data);
        setMetadata(data);
        setLoading(false);
      })
      .catch(error => {
        console.error(`Failed to load attachment ${attachmentId}:`, error);
        setLoading(false);
      });
  }, [attachmentId, apiEndpoint]);
  
  const handleClick = () => {
    window.open(`${apiEndpoint}/attachments/${attachmentId}/content`, '_blank');
  };
  
  if (loading) {
    return <div className="attachment-chip loading">Loading...</div>;
  }
  
  if (!metadata) {
    console.error(`AttachmentChip: No metadata for attachment ${attachmentId}. Loading state was:`, loading);
    return <div className="attachment-chip error">Attachment not found (ID: {attachmentId})</div>;
  }
  
  return (
    <div className="attachment-chip" onClick={handleClick} title="Click to view">
      <span className="attachment-icon">📄</span>
      <span className="attachment-name">{metadata.name}</span>
      <span className="attachment-type">{metadata.contentType}</span>
    </div>
  );
};