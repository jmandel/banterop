import React, { useState } from 'react';
import { NextStateSelect } from './NextStateSelect';
import type { A2ANextState } from '../../shared/a2a-types';

export function ManualComposer({ disabled, hint, placeholder, onSend, sending }:{ disabled:boolean; hint?:string; placeholder?:string; onSend:(t:string, n:A2ANextState)=>Promise<void>|void; sending:boolean }) {
  const [text, setText] = useState('');
  const [nextState, setNextState] = useState<A2ANextState>('working');
  async function send() {
    const t = text.trim(); if (!t || disabled) return;
    setText('');
    await onSend(t, nextState);
  }
  return (
    <div className="manual-composer">
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <input
          className="input"
          style={{ flex: 1 }}
          value={text}
          placeholder={placeholder || (disabled ? 'Not your turn yet…' : 'Type a message to the other side…')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!disabled) void send(); } }}
          disabled={disabled || sending}
        />
        <NextStateSelect value={nextState as any} onChange={(v)=>setNextState(v as any)} disabled={sending} order={['input-required','working','completed']} />
        <button className="btn" onClick={() => void send()} disabled={disabled || sending} aria-disabled={disabled || sending} title={disabled ? (hint || 'Not your turn to send') : 'Send message'}>
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
        /* Style inputs/selects uniformly; do not override .btn styles */
        .manual-composer input, .manual-composer select {
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
