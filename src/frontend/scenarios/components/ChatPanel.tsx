import React, { useEffect, useRef, useState } from 'react';

interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; timestamp: number; }

export function ChatPanel({
  messages,
  onSendMessage,
  isLoading,
  onStop,
  lastUserMessage,
  wascanceled,
  selectedModel,
  onModelChange,
  availableProviders,
}: {
  messages: ChatMessage[];
  onSendMessage: (m: string) => void;
  isLoading: boolean;
  onStop?: () => void;
  lastUserMessage?: string;
  wascanceled?: boolean;
  selectedModel: string;
  onModelChange: (m: string) => void;
  availableProviders: Array<{ name: string; models: string[] }>;
}) {
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'instant' }); }, [messages]);
  useEffect(() => {
    if (!isLoading && wascanceled && lastUserMessage && input === '') setInput(lastUserMessage);
  }, [isLoading, wascanceled, lastUserMessage]);
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (input.trim() && !isLoading) { onSendMessage(input.trim()); setInput(''); } };
  const fmt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="rounded-lg border border-gray-200 bg-white flex flex-col h-full overflow-hidden">
      <div className="border-b bg-white px-3 py-2 flex items-center justify-between overflow-hidden">
        {availableProviders.length > 0 && (
          <div className="flex items-center gap-2 min-w-0 w-full">
            <label className="text-xs text-gray-600 shrink-0">Model:</label>
            <div className="flex-1 min-w-0">
              <select
                className="w-full text-sm border rounded px-2 py-1 disabled:opacity-60"
                value={selectedModel}
                onChange={(e) => onModelChange(e.target.value)}
                disabled={isLoading}
                title={selectedModel}
              >
                {availableProviders.map(p => (
                  <optgroup key={p.name} label={p.name}>
                    {p.models.map(m => (<option key={m} value={m}>{m}</option>))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-lg font-semibold text-gray-900 mb-2">Welcome to the Scenario Builder!</p>
            <p className="text-sm text-gray-600 mb-4">I can help you modify your scenario through natural conversation.</p>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'text-right' : ''}>
              <span className={`inline-block rounded-2xl px-3 py-2 max-w-[70%] text-sm ${m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-900'}`}>{m.content}</span>
              <div className="text-[11px] text-slate-500 mt-1">{fmt(m.timestamp)}</div>
            </div>
          ))
        )}
        {isLoading && (
          <div className="text-left"><span className="inline-block rounded-2xl px-3 py-2 bg-slate-100 text-slate-900 text-sm"><span className="animate-pulse">Thinking...</span></span></div>
        )}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit} className="border-t p-2 flex gap-2">
        <input className="flex-1 border rounded-2xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Ask me to modify the scenario..." value={input} onChange={(e) => setInput(e.target.value)} disabled={isLoading} />
        {isLoading && onStop ? (
          <button type="button" className="rounded-2xl px-3 py-2 bg-rose-600 text-white text-sm hover:bg-rose-700" onClick={onStop}>Stop</button>
        ) : (
          <button type="submit" className="rounded-2xl px-3 py-2 bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" disabled={!input.trim() || isLoading}>Send</button>
        )}
      </form>
    </div>
  );
}
