import React, { useState } from 'react';
import { useAppStore } from '../state/store';

export function DebugPanel() {
  const facts = useAppStore(s => s.facts);
  const seq = useAppStore(s => s.seq);
  const taskId = useAppStore(s => s.taskId);
  const [copied, setCopied] = useState(false);
  const payload = JSON.stringify({ taskId, seq, facts }, null, 2);
  async function copy() {
    try { await navigator.clipboard.writeText(payload); setCopied(true); setTimeout(()=>setCopied(false), 1200); } catch {}
  }
  return (
    <aside className="debug-panel" aria-label="Debug facts panel">
      <div className="debug-header">
        <strong style={{ color:'#e3f0ff' }}>Journal</strong>
        <span style={{ marginLeft:'auto', fontSize:12, color:'#93c5fd' }}>seq {seq}</span>
        <button className="debug-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <div className="debug-body">
        <pre className="debug-pre">{payload}</pre>
      </div>
    </aside>
  );
}
