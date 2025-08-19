import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui';

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
  initialInput,
  disabled,
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
  initialInput?: string;
  disabled?: boolean;
}) {
  const [input, setInput] = useState(initialInput || '');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'instant' }); }, [messages]);
  useEffect(() => {
    if (!isLoading && wascanceled && lastUserMessage && input === '') setInput(lastUserMessage);
  }, [isLoading, wascanceled, lastUserMessage]);
  // Update input when initialInput changes (for scenario idea from URL)
  useEffect(() => {
    if (initialInput && input === '') {
      setInput(initialInput);
    }
  }, [initialInput]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    if (input.trim() && !isLoading) { onSendMessage(input.trim()); setInput(''); }
  };
  const fmt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--panel)] flex flex-col h-full overflow-hidden">
      <div className="border-b border-[color:var(--border)] bg-[color:var(--panel)] px-3 py-2 flex items-center justify-between overflow-hidden">
        {availableProviders.length > 0 && (
          <div className="flex items-center gap-2 min-w-0 w-full">
            <label className="text-xs text-[color:var(--muted)] shrink-0">Model:</label>
            <div className="flex-1 min-w-0">
              <select
                className="w-full text-sm border border-[color:var(--border)] rounded-2xl px-2 py-1 bg-[color:var(--panel)] text-[color:var(--text)] disabled:opacity-60"
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
            <p className="text-lg font-semibold text-[color:var(--text)] mb-2">Welcome to the Scenario Builder!</p>
            <p className="text-sm text-[color:var(--muted)] mb-4">I can help you modify your scenario through natural conversation.</p>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'text-right' : ''}>
              <span className={`inline-block rounded-2xl px-3 py-2 max-w-[70%] text-sm ${m.role === 'user' ? 'bg-[color:var(--primary)] text-[color:var(--primary-foreground)]' : 'bg-[color:var(--panel)] border border-[color:var(--border)] text-[color:var(--text)]'}`}>{m.content}</span>
              <div className="text-[11px] text-[color:var(--muted)] mt-1">{fmt(m.timestamp)}</div>
            </div>
          ))
        )}
        {isLoading && (
          <div className="text-left"><span className="inline-block rounded-2xl px-3 py-2 bg-[color:var(--panel)] border border-[color:var(--border)] text-[color:var(--text)] text-sm"><span className="animate-pulse">Thinking...</span></span></div>
        )}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit} className="border-t border-[color:var(--border)] p-2 flex gap-2">
        <input
          className="flex-1 border border-[color:var(--border)] rounded-2xl px-3 py-2 text-sm bg-[color:var(--panel)] text-[color:var(--text)] focus:outline-none disabled:opacity-60"
          placeholder={disabled ? "Published scenario is locked. Unlock to propose edits." : "Ask me to modify the scenario..."}
          title={disabled ? "Published scenario is locked. Unlock to propose edits." : undefined}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isLoading || disabled}
        />
        {isLoading && onStop ? (
          <Button variant="danger" size="sm" onClick={onStop}>Stop</Button>
        ) : (
          <Button variant="primary" size="sm" as="button" disabled={!input.trim() || isLoading || !!disabled} type="submit">Send</Button>
        )}
      </form>
    </div>
  );
}
