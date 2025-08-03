import React from 'react';
import type { TraceEntry } from '../types/index.js';

interface TraceEntryProps {
  entry: TraceEntry;
}

const icons: Record<string, string> = {
  thought: '💭',
  tool_call: '🔧',
  tool_result: '✅',
  user_query: '❓',
  user_response: '💬'
};

// Simple markdown renderer that handles basic formatting
function renderMarkdown(text: string): string {
  return text
    // Headers
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Line breaks
    .replace(/\n/g, '<br>')
    // Code blocks (simple version)
    .replace(/```([\s\S]*?)```/g, '<pre style="background: #2a2a2a; padding: 8px; border-radius: 4px; overflow: auto;">$1</pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code style="background: #2a2a2a; padding: 2px 4px; border-radius: 3px;">$1</code>');
}

export const TraceEntryComponent: React.FC<TraceEntryProps> = ({ entry }) => {
  let content: React.ReactNode = '';
  
  switch (entry.type) {
    case 'thought':
      content = entry.content;
      break;
      
    case 'tool_call':
      content = (
        <div>
          <div style={{ fontWeight: 'bold' }}>Called: {entry.toolName}</div>
          <pre style={{ 
            margin: '0.25rem 0 0 1rem', 
            fontSize: '0.8rem',
            backgroundColor: '#2a2a2a',
            padding: '0.5rem',
            borderRadius: '4px',
            overflow: 'auto'
          }}>
            {JSON.stringify(entry.parameters, null, 2)}
          </pre>
        </div>
      );
      break;
      
    case 'tool_result':
      const hasResult = entry.result !== undefined && entry.result !== null;
      
      // Check if result has markdown content
      const isMarkdownContent = hasResult && 
        typeof entry.result === 'object' && 
        entry.result.contentType === 'text/markdown' && 
        entry.result.content;
      
      if (isMarkdownContent) {
        content = (
          <div>
            <div style={{ fontWeight: 'bold', color: '#10b981' }}>
              Result: Document Content
            </div>
            <div style={{ 
              margin: '0.25rem 0 0 1rem', 
              padding: '0.5rem',
              backgroundColor: '#1f3a2a',
              borderRadius: '4px',
              fontSize: '0.9rem',
              lineHeight: '1.5'
            }}>
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.result.content) }} />
            </div>
          </div>
        );
      } else {
        const resultDisplay = entry.error 
          ? entry.error 
          : hasResult 
            ? (typeof entry.result === 'string' 
                ? entry.result 
                : JSON.stringify(entry.result, null, 2))
            : 'No result data';
            
        content = (
          <div>
            <div style={{ fontWeight: 'bold', color: entry.error ? '#ef4444' : '#10b981' }}>
              Result: {entry.error ? 'Error' : 'Success'}
            </div>
            <pre style={{ 
              margin: '0.25rem 0 0 1rem', 
              fontSize: '0.8rem',
              backgroundColor: entry.error ? '#3a1f1f' : '#1f3a2a',
              padding: '0.5rem',
              borderRadius: '4px',
              overflow: 'auto',
              minHeight: '1.5rem'
            }}>
              {resultDisplay}
            </pre>
          </div>
        );
      }
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
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
        <span style={{ flexShrink: 0 }}>{icons[entry.type] || '•'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {content}
        </div>
      </div>
    </div>
  );
};