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
  wascanceled?: boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
  availableProviders: Array<{ name: string; models: string[] }>;
}

export function ChatPanel({ messages, onSendMessage, isLoading, onStop, lastUserMessage, wascanceled, selectedModel, onModelChange, availableProviders }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages]);
  
  // Restore input only when loading is canceled (not on normal completion)
  useEffect(() => {
    if (!isLoading && wascanceled && lastUserMessage && input === '') {
      setInput(lastUserMessage);
    }
  }, [isLoading, wascanceled, lastUserMessage]);

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
    <div className="rounded-lg border border-gray-200 bg-white flex flex-col h-full overflow-hidden">
      <div className="border-b bg-white px-3 py-2 flex items-center justify-between">
        {availableProviders.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor="model-select" className="text-xs text-gray-600">Model:</label>
            <select
              id="model-select"
              className="text-sm border rounded px-2 py-1 disabled:opacity-60"
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

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-lg font-semibold text-gray-900 mb-2">Welcome to the Scenario Builder!</p>
            <p className="text-sm text-gray-600 mb-4">
              I can help you modify your scenario through natural conversation.
              Try asking me to:
            </p>
            <ul className="text-sm text-gray-600 space-y-1 text-left max-w-md mx-auto">
              <li>• Update agent information (principal, goals, situation)</li>
              <li>• Add or modify tools for any agent</li>
              <li>• Change agent knowledge base entries</li>
              <li>• Set agent initiation messages</li>
              <li>• Configure which agent starts the conversation</li>
              <li>• Add terminal tools (with endsConversation: true)</li>
              <li>• Modify scenario background or challenges</li>
            </ul>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={message.role === 'user' ? 'text-right' : ''}>
              <span className={`inline-block rounded-2xl px-3 py-2 max-w-[70%] text-sm ${
                message.role === 'user' 
                  ? 'bg-blue-600 text-white' 
                  : 'bg-slate-100 text-slate-900'
              }`}>
                {message.content}
              </span>
              <div className="text-[11px] text-slate-500 mt-1">
                {formatTime(message.timestamp)}
              </div>
            </div>
          ))
        )}
        {isLoading && (
          <div className="text-left">
            <span className="inline-block rounded-2xl px-3 py-2 bg-slate-100 text-slate-900 text-sm">
              <span className="animate-pulse">Thinking...</span>
            </span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="border-t p-2 flex gap-2">
        <input
          type="text"
          className="flex-1 border rounded-2xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Ask me to modify the scenario..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isLoading}
        />
        {isLoading && onStop ? (
          <button
            type="button"
            className="rounded-2xl px-3 py-2 bg-rose-600 text-white text-sm hover:bg-rose-700"
            onClick={onStop}
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="rounded-2xl px-3 py-2 bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
            disabled={!input.trim() || isLoading}
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}