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
  onStop?: () => void;
  lastUserMessage?: string;
  selectedModel: string;
  onModelChange: (model: string) => void;
  availableProviders: Array<{ name: string; models: string[] }>;
}

export function ChatPanel({ messages, onSendMessage, isLoading, onStop, lastUserMessage, selectedModel, onModelChange, availableProviders }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages]);
  
  // Restore input when loading is cancelled
  useEffect(() => {
    if (!isLoading && lastUserMessage && input === '') {
      setInput(lastUserMessage);
    }
  }, [isLoading, lastUserMessage]);

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
        <div className="chat-header-title">Scenario Builder Assistant</div>
        {availableProviders.length > 0 && (
          <div className="chat-header-model-selector">
            <label htmlFor="model-select" className="model-label">Model:</label>
            <select
              id="model-select"
              className="model-select"
              value={selectedModel}
              onChange={(e) => onModelChange(e.target.value)}
              disabled={isLoading}
            >
              {availableProviders.map(provider => (
                <optgroup key={provider.name} label={provider.name}>
                  {provider.models.map(model => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        )}
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
        {isLoading && (
          <div className="chat-message assistant loading">
            <div className="message-bubble">
              <span className="loading-dots">Thinking</span>
            </div>
          </div>
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
          {isLoading && onStop ? (
            <button
              type="button"
              className="chat-stop-btn"
              onClick={onStop}
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="chat-send-btn"
              disabled={!input.trim() || isLoading}
            >
              Send
            </button>
          )}
        </form>
      </div>
    </div>
  );
}