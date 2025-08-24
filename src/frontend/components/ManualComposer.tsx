import React, { useState } from 'react';

export type Finality = 'none' | 'turn' | 'conversation';

export function ManualComposer({
  disabled,
  hint,
  onSend,
}: {
  disabled: boolean;
  hint?: string;
  onSend: (text: string, finality: Finality) => Promise<void> | void;
}) {
  const [text, setText] = useState('');
  const [finality, setFinality] = useState<Finality>('turn');
  const [busy, setBusy] = useState(false);

  async function send() {
    const t = text.trim();
    if (!t || disabled || busy) return;
    setBusy(true);
    try {
      await onSend(t, finality);
      setText('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="manual-composer">
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <input
          className="input"
          style={{ flex: 1 }}
          value={text}
          placeholder={disabled ? 'Not your turn yet…' : 'Type a message to the other side…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void send(); } }}
          disabled={busy}
        />
        <select
          value={finality}
          onChange={(e) => setFinality(e.target.value as Finality)}
          disabled={busy}
          title="Finality hint"
        >
          <option value="none">no finality</option>
          <option value="turn">end turn → flip</option>
          <option value="conversation">end conversation</option>
        </select>
        <button
          className="btn"
          onClick={() => void send()}
          disabled={disabled || busy}
          aria-disabled={disabled || busy}
          title={disabled ? (hint || 'Not your turn to send') : 'Send message'}
        >
          Send
        </button>
      </div>
      {hint && <div className="small muted" style={{ marginTop: 6 }}>{hint}</div>}
      <style>{`
        .manual-composer {
          position: sticky;
          bottom: 0;
          background: #fff;
          border-top: 1px solid #e6e8ee;
          padding: 10px;
          border-radius: 0 0 10px 10px;
        }
        .manual-composer input, .manual-composer select, .manual-composer button {
          font: inherit;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid #d4d8e2;
          background: #fff;
        }
      `}</style>
    </div>
  );
}

