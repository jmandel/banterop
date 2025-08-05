import React, { useState, useRef, useEffect } from 'react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface ChatPanelProps {
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
  isLoading: boolean;
}

export function ChatPanel({ messages, onSendMessage, isLoading }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      onSendMessage(input.trim());
      setInput('');
    }
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        Scenario Builder Assistant
      </div>

      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <p className="welcome-title">Welcome to the Scenario Builder!</p>
            <p className="welcome-subtitle">
              I can help you modify your scenario through natural conversation.
              Try asking me to:
            </p>
            <ul className="welcome-list">
              <li>Update agent information (principal, goals, situation)</li>
              <li>Add or modify tools for any agent</li>
              <li>Change agent knowledge base entries</li>
              <li>Set agent initiation messages (messageToUseWhenInitiatingConversation)</li>
              <li>Configure which agent starts the conversation</li>
              <li>Add terminal tools (with endsConversation: true)</li>
              <li>Modify scenario background or challenges</li>
            </ul>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`chat-message ${message.role}`}>
              <div className="message-bubble">
                {message.content}
              </div>
              <div className="message-time">
                {formatTime(message.timestamp)}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-container">
        <form onSubmit={handleSubmit} className="chat-input-form">
          <input
            type="text"
            className="chat-input"
            placeholder="Ask me to modify the scenario..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isLoading}
          />
          <button
            type="submit"
            className="chat-send-btn"
            disabled={!input.trim() || isLoading}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}